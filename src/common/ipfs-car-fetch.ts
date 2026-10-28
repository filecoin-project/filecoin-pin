/**
 * Find the providers that serve an IPFS root CID, download its CAR from the first that
 * answers, and verify every block before anything else reads it.
 *
 * Candidates come from IPNI (`cid.contact`) and, when an address is known, from the
 * providers of that address's own data sets. Any provider is accepted: the CAR is
 * checked block by block against the requested CID, so a provider can only fail, never lie.
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { SIZE_CONSTANTS } from '@filoz/synapse-core/utils'
import { METADATA_KEYS, type Synapse } from '@filoz/synapse-sdk'
import { CarBlockIterator } from '@ipld/car'
import * as dagCbor from '@ipld/dag-cbor'
import * as dagPb from '@ipld/dag-pb'
import { varint } from 'multiformats'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import type { Logger } from 'pino'
import { listDataSets } from '../core/data-set/index.js'
import { type IpniIndexerResponse, multiaddrToNormalizedUri } from '../core/utils/validate-ipni-advertisement.js'
import { CAR_CONTENT_TYPE, DAG_PB_CODEC, RAW_CODEC } from './unixfs-car-layout.js'

/** Provider requests in flight at once. */
export const FETCH_CONCURRENCY = 4
/** How long a provider may take to answer with headers. */
export const RESPONSE_TIMEOUT_MS = 30_000
/** How long a response body may go without sending a byte. */
export const BODY_IDLE_TIMEOUT_MS = 30_000
/** How long one discovery source (IPNI, the own data set listing) may take. */
export const DISCOVERY_TIMEOUT_MS = 20_000
/**
 * Largest CAR accepted: the largest upload Synapse accepts plus 64 MiB for a gateway's own
 * framing (a rebuilt CAR may use other CID forms and section headers than the stored one).
 */
export const MAX_CAR_BYTES = SIZE_CONSTANTS.MAX_UPLOAD_SIZE + 64 * 1024 * 1024
/** Largest block a trustless gateway serves; a larger CAR section is refused before it is read. */
export const MAX_BLOCK_BYTES = 2 * 1024 * 1024
/** A section also holds its CID: a few dozen bytes for the hashes accepted here. */
const MAX_SECTION_BYTES = MAX_BLOCK_BYTES + 256
export const DEFAULT_IPNI_INDEXER_URL = 'https://cid.contact'
/** Trustless gateway CAR: depth-first, each block once (`dups=y` can inflate a response many times over). */
export const CAR_ACCEPT = 'application/vnd.ipld.car;version=1;order=dfs;dups=n'

const IDENTITY_CODE = 0x00

export interface FetchOptions {
  fetch?: typeof fetch
  signal?: AbortSignal
  logger?: Logger | undefined
  concurrency?: number
  /** Largest CAR to download; {@link MAX_CAR_BYTES} by default. */
  maxCarBytes?: number
}

/** One way to find providers; `find` should stop when `signal` aborts. */
export interface ProviderSource {
  /** Shown in errors, e.g. `IPNI`. */
  name: string
  find(signal: AbortSignal): Promise<string[]>
}

/** Content that hashes correctly but is not UnixFS: no provider can do better, so nothing is retried. */
export class NotUnixfsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Not a UnixFS file or directory: ${message}`, options)
    this.name = 'NotUnixfsError'
  }
}

/** The DAG uses a hash this reader cannot check: no provider can do better, so nothing is retried. */
export class UnsupportedHashError extends Error {
  constructor(cid: CID) {
    super(`${cid} uses hash 0x${cid.multihash.code.toString(16)}; only sha2-256 and identity are supported`)
    this.name = 'UnsupportedHashError'
  }
}

/** A provider's CAR that does not prove the requested DAG: the next provider is tried. */
export class CarVerifyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CarVerifyError'
  }
}

/** Nobody has the CID: discovery worked, and every provider found (if any) answered 404. */
export class NoProviderError extends Error {
  constructor(cid: string) {
    super(
      `No provider serves ${cid} over IPFS. If it was uploaded in the last few minutes, try again in about 20 minutes`
    )
    this.name = 'NoProviderError'
  }
}

/** No verified CAR, for a reason other than "nobody has it"; the message says which. */
export class FetchFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FetchFailedError'
  }
}

/** `url` without trailing slashes, or undefined unless it is http(s). */
export function providerBaseUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return parsed.href.replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

/** The HTTP(S) addresses IPNI lists for `cid`; a 404 means none. */
export async function ipniProviderUrls(
  cid: CID,
  options: Pick<FetchOptions, 'fetch' | 'signal'> & { ipniIndexerUrl?: string } = {}
): Promise<string[]> {
  const doFetch = options.fetch ?? fetch
  const response = await doFetch(`${options.ipniIndexerUrl ?? DEFAULT_IPNI_INDEXER_URL}/cid/${cid}`, {
    headers: { Accept: 'application/json' },
    ...(options.signal != null && { signal: options.signal }),
  })
  if (response.status === 404) return []
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
  const body = (await response.json()) as IpniIndexerResponse
  return (
    (body.MultihashResults ?? [])
      .flatMap((result) => result.ProviderResults ?? [])
      .flatMap((result) => result.Provider?.Addrs ?? [])
      // A bare `/tcp` address is libp2p, though multiaddr-to-uri renders it as http://.
      .filter((addr) => /\/https?(\/|$)/.test(addr))
      .map(multiaddrToNormalizedUri)
      .filter((url) => providerBaseUrl(url) != null)
  )
}

/** PDP service URLs of the providers holding the client's live, IPFS-indexed data sets with pieces. */
export async function ownProviderUrls(synapse: Synapse, logger?: Logger): Promise<string[]> {
  const dataSets = await listDataSets(synapse, {
    filter: (dataSet) =>
      dataSet.isLive && dataSet.hasActivePieces && dataSet.metadata?.[METADATA_KEYS.WITH_IPFS_INDEXING] != null,
    logger,
  })
  return dataSets.flatMap((dataSet) => dataSet.provider?.pdp?.serviceURL ?? [])
}

/** A short reason safe to print: URLs are dropped, since an RPC URL can carry an API key. */
export function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').slice(0, 200)
}

/** Run one source with its own deadline, even when `find` ignores the signal. */
async function discover(source: ProviderSource, outer: AbortSignal | undefined): Promise<string[]> {
  const controller = new AbortController()
  const signal = outer == null ? controller.signal : AbortSignal.any([outer, controller.signal])
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`timed out after ${DISCOVERY_TIMEOUT_MS / 1000} s`)
      controller.abort(error)
      reject(error)
    }, DISCOVERY_TIMEOUT_MS)
  })
  try {
    return await Promise.race([source.find(signal), deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** What happened to each source and provider, for an accurate final error. */
interface Attempts {
  discoveryErrors: string[]
  /** Providers that answered something other than a usable 200 (404, 5xx, network error, timeout). */
  unavailable: Map<string, string>
  /** Providers whose CAR failed while downloading or verifying. */
  invalid: Map<string, string>
}

const plural = (n: number): string => `${n} provider${n === 1 ? '' : 's'}`

/** The error once every candidate is used up: the most informative failure wins. */
function exhausted(cid: CID, attempts: Attempts): Error {
  const { discoveryErrors, unavailable, invalid } = attempts
  if (invalid.size > 0) {
    return new FetchFailedError(
      `${plural(invalid.size)} sent invalid data for ${cid}: ${[...new Set(invalid.values())].join('; ')}`
    )
  }
  const failures = [...unavailable.values()].filter((reason) => reason !== 'HTTP 404')
  if (failures.length > 0) {
    return new FetchFailedError(
      `Could not download ${cid} from ${plural(unavailable.size)}: ${[...new Set(failures)].join('; ')}`
    )
  }
  if (discoveryErrors.length > 0) {
    return new FetchFailedError(`Could not look up providers for ${cid}: ${discoveryErrors.join('; ')}`)
  }
  return new NoProviderError(cid.toString())
}

interface Winner {
  base: string
  response: Response
  controller: AbortController
}

/**
 * Download the CAR for `cid` into `carPath` (created exclusively, owner-only) from the first
 * candidate that answers 200 with a CAR, and verify it with {@link verifyCar}. Each source runs
 * once with a {@link DISCOVERY_TIMEOUT_MS} deadline; its providers are merged and de-duplicated
 * as they arrive. A body that stalls for {@link BODY_IDLE_TIMEOUT_MS}, grows past the size cap
 * or fails verification is deleted, and the remaining candidates race again without the
 * providers that already failed.
 *
 * @throws {NoProviderError} when nobody has the CID.
 * @throws {FetchFailedError} when discovery or every provider failed; the message says how.
 * @throws {NotUnixfsError} or {@link UnsupportedHashError} for content no provider can fix.
 */
export async function fetchVerifiedCar(
  cid: CID,
  sources: ProviderSource[],
  carPath: string,
  options: FetchOptions = {}
): Promise<{ provider: string }> {
  const { logger, signal } = options
  const maxCarBytes = options.maxCarBytes ?? MAX_CAR_BYTES
  const attempts: Attempts = { discoveryErrors: [], unavailable: new Map(), invalid: new Map() }
  const settled = sources.map((source) =>
    discover(source, signal).catch((error: unknown) => {
      const reason = `${source.name} lookup failed: ${reasonOf(error)}`
      attempts.discoveryErrors.push(reason)
      logger?.warn({ source: source.name, reason }, 'Provider discovery failed')
      return []
    })
  )
  for (;;) {
    const winner = await firstCarResponse(cid, settled, attempts, { ...options, maxCarBytes })
    let downloaded = false
    try {
      const body = Readable.fromWeb(winner.response.body as import('node:stream/web').ReadableStream<Uint8Array>)
      await pipeline(
        body,
        guardBody(winner.controller, maxCarBytes),
        createWriteStream(carPath, { flags: 'wx', mode: 0o600 }),
        { ...(signal != null && { signal }) }
      )
      downloaded = true
      await verifyCar(carPath, cid)
      return { provider: winner.base }
    } catch (error) {
      winner.controller.abort()
      await rm(carPath, { force: true, maxRetries: 3 })
      if (signal?.aborted === true || error instanceof NotUnixfsError || error instanceof UnsupportedHashError) {
        throw error
      }
      // A body that stalled or outgrew the cap is a failed download; a complete one that does not verify is invalid.
      ;(downloaded ? attempts.invalid : attempts.unavailable).set(winner.base, reasonOf(error))
      logger?.warn({ provider: winner.base, reason: reasonOf(error) }, 'Discarded a provider response')
    }
  }
}

/** Pass the body through, failing once it exceeds `maxBytes` or sends nothing for {@link BODY_IDLE_TIMEOUT_MS}. */
function guardBody(controller: AbortController, maxBytes: number): Transform {
  let total = 0
  let timer: NodeJS.Timeout | undefined
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      arm()
      total += chunk.length
      if (total > maxBytes) {
        callback(new CarVerifyError(`the CAR is larger than ${maxBytes} bytes`))
        return
      }
      callback(null, chunk)
    },
    flush(callback) {
      clearTimeout(timer)
      callback()
    },
    destroy(error, callback) {
      clearTimeout(timer)
      callback(error)
    },
  })
  const arm = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      const error = new CarVerifyError(`no data for ${BODY_IDLE_TIMEOUT_MS / 1000} s`)
      // The abort closes the connection; destroying the guard ends the pipeline even if it does not.
      controller.abort(error)
      guard.destroy(error)
    }, BODY_IDLE_TIMEOUT_MS)
  }
  arm()
  return guard
}

/** Why a response cannot win, or undefined when it is a usable CAR. */
function unusable(response: Response, maxBytes: number): string | undefined {
  if (response.status !== 200 || response.body == null) return `HTTP ${response.status}`
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (type !== CAR_CONTENT_TYPE) return `content type ${type ?? 'missing'}, not a CAR`
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > maxBytes) return `the CAR is ${length} bytes, more than ${maxBytes}`
  return undefined
}

/** The first usable 200 among the candidates, at most `concurrency` requests at a time; the rest are aborted. */
function firstCarResponse(
  cid: CID,
  sources: Array<Promise<string[]>>,
  attempts: Attempts,
  options: FetchOptions & { maxCarBytes: number }
): Promise<Winner> {
  const doFetch = options.fetch ?? fetch
  const limit = options.concurrency ?? FETCH_CONCURRENCY
  const outer = options.signal
  const tried = (base: string): boolean => attempts.unavailable.has(base) || attempts.invalid.has(base)
  return new Promise((resolve, reject) => {
    const queue: string[] = []
    const queued = new Set<string>()
    const inFlight = new Map<string, AbortController>()
    let openSources = sources.length
    let done = false

    const settle = (winner?: Winner, error?: unknown): void => {
      done = true
      outer?.removeEventListener('abort', onAbort)
      for (const controller of inFlight.values()) controller.abort()
      inFlight.clear()
      if (winner != null) resolve(winner)
      else reject(error)
    }
    const onAbort = (): void => settle(undefined, outer?.reason)
    if (outer?.aborted === true) {
      reject(outer.reason)
      return
    }
    outer?.addEventListener('abort', onAbort, { once: true })

    const pump = (): void => {
      while (!done && inFlight.size < limit && queue.length > 0) {
        const base = queue.shift()
        if (base != null) start(base)
      }
      if (!done && openSources === 0 && queue.length === 0 && inFlight.size === 0) {
        settle(undefined, exhausted(cid, attempts))
      }
    }
    const lose = (base: string, reason: string): void => {
      if (done) return
      inFlight.delete(base)
      attempts.unavailable.set(base, reason)
      options.logger?.debug({ provider: base, reason }, 'Provider did not serve the CAR')
      pump()
    }
    const start = (base: string): void => {
      const controller = new AbortController()
      inFlight.set(base, controller)
      const timer = setTimeout(
        () => controller.abort(new Error(`no response in ${RESPONSE_TIMEOUT_MS / 1000} s`)),
        RESPONSE_TIMEOUT_MS
      )
      const signal = outer == null ? controller.signal : AbortSignal.any([outer, controller.signal])
      doFetch(`${base}/ipfs/${cid}?format=car&dag-scope=all`, { headers: { Accept: CAR_ACCEPT }, signal }).then(
        (response) => {
          clearTimeout(timer)
          const reason = done ? 'aborted' : unusable(response, options.maxCarBytes)
          if (reason != null) {
            response.body?.cancel().catch(() => undefined)
            lose(base, reason)
            return
          }
          inFlight.delete(base)
          settle({ base, response, controller })
        },
        (error: unknown) => {
          clearTimeout(timer)
          lose(base, reasonOf(controller.signal.aborted ? controller.signal.reason : error))
        }
      )
    }
    const enqueue = (urls: string[]): void => {
      for (const url of urls) {
        const base = providerBaseUrl(url)
        if (base == null || tried(base) || queued.has(base)) continue
        queued.add(base)
        queue.push(base)
      }
    }
    for (const source of sources) {
      source.then(enqueue).finally(() => {
        openSources--
        pump()
      })
    }
  })
}

/** Same block: CIDv0 and CIDv1 of one dag-pb node name the same bytes. */
const blockKey = (cid: CID): string => `${cid.code}:${Buffer.from(cid.multihash.bytes).toString('base64')}`

/** Whether this reader can check `cid`'s hash. */
export const isSupportedHash = (cid: CID): boolean =>
  cid.multihash.code === sha256.code || cid.multihash.code === IDENTITY_CODE

async function assertHash(cid: CID, bytes: Uint8Array): Promise<void> {
  const { code, digest } = cid.multihash
  let actual: Uint8Array
  if (code === sha256.code) {
    actual = (await sha256.digest(bytes)).digest
  } else if (code === IDENTITY_CODE) {
    actual = bytes
  } else {
    throw new UnsupportedHashError(cid)
  }
  if (Buffer.compare(Buffer.from(actual), Buffer.from(digest)) !== 0) {
    throw new CarVerifyError(`block ${cid} does not match its CID`)
  }
}

/** The CIDs a verified block links to, in link order. */
function linksOf(cid: CID, bytes: Uint8Array): CID[] {
  if (cid.code === RAW_CODEC) return []
  if (cid.code !== DAG_PB_CODEC) {
    throw new NotUnixfsError(`block ${cid} has codec 0x${cid.code.toString(16)}`)
  }
  try {
    // dag-pb's multiformats is a different major than ours; cross by bytes.
    return dagPb.decode(bytes).Links.map((link) => CID.decode(link.Hash.bytes))
  } catch (error) {
    throw new NotUnixfsError(`block ${cid} is not valid dag-pb`, { cause: error })
  }
}

/** The section's length prefix; multiformats throws a RangeError when the bytes end first. */
function decodeSectionLength(bytes: Uint8Array): [number, number] {
  try {
    return varint.decode(bytes)
  } catch (error) {
    if (error instanceof RangeError) throw new CarVerifyError('malformed CAR section header')
    throw error
  }
}

/**
 * Walk the section framing of the CAR at `carPath` without reading any block: the header must
 * be CARv1 and no section may exceed {@link MAX_BLOCK_BYTES} plus its CID. `@ipld/car` buffers
 * a whole section before parsing it, so a forged length would otherwise pull the rest of the
 * file into memory. One small read per section; the file is already capped in size.
 */
async function checkFraming(carPath: string): Promise<void> {
  const file = await open(carPath, 'r')
  try {
    const { size } = await file.stat()
    const head = new Uint8Array(10)
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await file.read(head, 0, head.length, offset)
      const [length, varintBytes] = decodeSectionLength(head.subarray(0, bytesRead))
      if (length > MAX_SECTION_BYTES) {
        throw new CarVerifyError(`a CAR section is ${length} bytes, more than the ${MAX_BLOCK_BYTES}-byte block limit`)
      }
      if (offset === 0) {
        const header = new Uint8Array(length)
        await file.read(header, 0, length, varintBytes)
        const { version } = dagCbor.decode<{ version?: unknown }>(header)
        if (version !== 1) throw new CarVerifyError(`CAR version ${String(version)}; only CARv1 is accepted`)
      }
      offset += varintBytes + length
    }
  } finally {
    await file.close()
  }
}

/**
 * Check that the CAR at `carPath` is exactly the trustless-gateway answer for `root` with
 * `order=dfs&dups=n`: a CARv1 with a single header root equal to `root`, then every block of
 * the DAG in depth-first link order, each once, each hashing to its CID (sha2-256 or
 * identity). A block out of order, an extra block, or a block the DAG needs but the CAR lacks
 * fails. Curio answers 200 with a cut-short CAR when it lacks blocks, so the last case is
 * common. An identity CID carries its block inline: its links are walked whether or not the
 * CAR repeats it.
 *
 * Only dag-pb and raw blocks are walked; another codec is {@link NotUnixfsError}.
 */
export async function verifyCar(carPath: string, root: CID): Promise<void> {
  const stream = createReadStream(carPath)
  try {
    await checkFraming(carPath)
    const blocks = await CarBlockIterator.fromIterable(stream)
    const roots = await blocks.getRoots()
    const headerRoot = roots[0]
    if (roots.length !== 1 || headerRoot == null || blockKey(CID.decode(headerRoot.bytes)) !== blockKey(root)) {
      throw new CarVerifyError('the CAR is not rooted at the requested CID')
    }
    const seen = new Set<string>()
    // Pre-order DFS: the next expected block is on top of the stack.
    const stack: CID[] = [root]
    // The next block the CAR must hold, expanding inline identity blocks on the way.
    const nextExpected = (arriving: string | undefined): CID | undefined => {
      for (;;) {
        const expected = stack.pop()
        if (expected == null) return undefined
        const key = blockKey(expected)
        // dups=n skips blocks already sent.
        if (seen.has(key)) continue
        if (expected.multihash.code === IDENTITY_CODE && key !== arriving) {
          seen.add(key)
          stack.push(...linksOf(expected, expected.multihash.digest).reverse())
          continue
        }
        return expected
      }
    }
    for await (const block of blocks) {
      const cid = CID.decode(block.cid.bytes)
      const key = blockKey(cid)
      const expected = nextExpected(key)
      if (expected == null) throw new CarVerifyError(`unexpected extra block ${cid}`)
      if (blockKey(expected) !== key) {
        throw new CarVerifyError(`block ${cid} arrived out of order or is not part of the DAG`)
      }
      await assertHash(cid, block.bytes)
      seen.add(key)
      stack.push(...linksOf(cid, block.bytes).reverse())
    }
    const missing = nextExpected(undefined)
    if (missing != null) {
      if (!isSupportedHash(missing)) throw new UnsupportedHashError(missing)
      throw new CarVerifyError(`incomplete download: block ${missing} is missing`)
    }
  } catch (error) {
    if (error instanceof CarVerifyError || error instanceof NotUnixfsError || error instanceof UnsupportedHashError) {
      throw error
    }
    throw new CarVerifyError('incomplete or malformed CAR', { cause: error })
  } finally {
    stream.destroy()
  }
}
