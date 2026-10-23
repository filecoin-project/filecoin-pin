/**
 * Find the providers that serve an IPFS root CID, download its CAR from the first that
 * answers, and verify every block before anything else reads it.
 *
 * Candidates come from IPNI (`cid.contact`) and, when an address is known, from the
 * providers of that address's own data sets. Any provider is accepted: the CAR is
 * checked block by block against the requested CID, so a provider can only fail, never lie.
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { METADATA_KEYS, type Synapse } from '@filoz/synapse-sdk'
import { CarBlockIterator } from '@ipld/car'
import * as dagPb from '@ipld/dag-pb'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import type { Logger } from 'pino'
import { listDataSets } from '../core/data-set/index.js'
import { type IpniIndexerResponse, multiaddrToNormalizedUri } from '../core/utils/validate-ipni-advertisement.js'
import { DAG_PB_CODEC, RAW_CODEC } from './unixfs-car-layout.js'

/** Provider requests in flight at once. */
export const FETCH_CONCURRENCY = 4
/** How long a provider may take to answer with headers; the body itself has no deadline. */
export const RESPONSE_TIMEOUT_MS = 30_000
export const DEFAULT_IPNI_INDEXER_URL = 'https://cid.contact'
/** Trustless gateway CAR: depth-first, each block once (`dups=y` can inflate a response many times over). */
export const CAR_ACCEPT = 'application/vnd.ipld.car;version=1;order=dfs;dups=n'

const IDENTITY_CODE = 0x00

export interface FetchOptions {
  fetch?: typeof fetch
  signal?: AbortSignal
  logger?: Logger | undefined
}

/** Content that hashes correctly but is not UnixFS: no provider can do better, so nothing is retried. */
export class NotUnixfsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Not a UnixFS file or directory: ${message}`, options)
    this.name = 'NotUnixfsError'
  }
}

/** A provider's CAR that does not prove the requested DAG: the next provider is tried. */
export class CarVerifyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CarVerifyError'
  }
}

export class NoProviderError extends Error {
  constructor(cid: string) {
    super(`No provider serves ${cid} over IPFS`)
    this.name = 'NoProviderError'
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
  options: FetchOptions & { ipniIndexerUrl?: string } = {}
): Promise<string[]> {
  const doFetch = options.fetch ?? fetch
  const response = await doFetch(`${options.ipniIndexerUrl ?? DEFAULT_IPNI_INDEXER_URL}/cid/${cid}`, {
    headers: { Accept: 'application/json' },
    ...(options.signal != null && { signal: options.signal }),
  })
  if (response.status === 404) return []
  if (!response.ok) throw new Error(`IPNI lookup failed: HTTP ${response.status}`)
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

interface Winner {
  base: string
  response: Response
}

/**
 * Download the CAR for `cid` into `carPath` (created exclusively, owner-only) from the first
 * candidate that answers 200, and verify it with {@link verifyCar}. `sources` each resolve to
 * provider URLs, merged and de-duplicated as they arrive; a rejected source is logged and
 * ignored. A failed download or verification is deleted and the remaining candidates race
 * again, without the providers that already failed.
 *
 * @throws {NoProviderError} when no candidate yields a verified CAR.
 * @throws {NotUnixfsError} when the verified DAG is not UnixFS.
 */
export async function fetchVerifiedCar(
  cid: CID,
  sources: Array<Promise<string[]>>,
  carPath: string,
  options: FetchOptions & { concurrency?: number } = {}
): Promise<{ provider: string }> {
  const { logger, signal } = options
  const settled = sources.map((source) =>
    source.catch((error: unknown) => {
      logger?.warn({ err: error }, 'Provider discovery failed')
      return []
    })
  )
  const failed = new Set<string>()
  for (;;) {
    const winner = await firstCarResponse(cid, settled, failed, options)
    try {
      const body = Readable.fromWeb(winner.response.body as import('node:stream/web').ReadableStream<Uint8Array>)
      await pipeline(body, createWriteStream(carPath, { flags: 'wx', mode: 0o600 }), {
        ...(signal != null && { signal }),
      })
      await verifyCar(carPath, cid)
      return { provider: winner.base }
    } catch (error) {
      await rm(carPath, { force: true })
      if (signal?.aborted === true || error instanceof NotUnixfsError) throw error
      failed.add(winner.base)
      logger?.warn({ provider: winner.base, err: error }, 'Discarded a provider response')
    }
  }
}

/** The first 200 among the candidates, at most `concurrency` requests at a time; the rest are aborted. */
function firstCarResponse(
  cid: CID,
  sources: Array<Promise<string[]>>,
  skip: Set<string>,
  options: FetchOptions & { concurrency?: number }
): Promise<Winner> {
  const doFetch = options.fetch ?? fetch
  const limit = options.concurrency ?? FETCH_CONCURRENCY
  const outer = options.signal
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
        settle(undefined, new NoProviderError(cid.toString()))
      }
    }
    const lose = (base: string, reason: unknown): void => {
      if (done) return
      inFlight.delete(base)
      skip.add(base)
      options.logger?.debug({ provider: base, reason }, 'Provider did not serve the CAR')
      pump()
    }
    const start = (base: string): void => {
      const controller = new AbortController()
      inFlight.set(base, controller)
      const timer = setTimeout(() => controller.abort(new Error('no response in time')), RESPONSE_TIMEOUT_MS)
      const signal = outer == null ? controller.signal : AbortSignal.any([outer, controller.signal])
      doFetch(`${base}/ipfs/${cid}?format=car&dag-scope=all`, { headers: { Accept: CAR_ACCEPT }, signal }).then(
        (response) => {
          clearTimeout(timer)
          if (done || response.status !== 200 || response.body == null) {
            response.body?.cancel().catch(() => undefined)
            lose(base, `HTTP ${response.status}`)
            return
          }
          inFlight.delete(base)
          settle({ base, response })
        },
        (error: unknown) => {
          clearTimeout(timer)
          lose(base, error)
        }
      )
    }
    const enqueue = (urls: string[]): void => {
      for (const url of urls) {
        const base = providerBaseUrl(url)
        if (base == null || skip.has(base) || queued.has(base)) continue
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

async function assertHash(cid: CID, bytes: Uint8Array): Promise<void> {
  const { code, digest } = cid.multihash
  let actual: Uint8Array
  if (code === sha256.code) {
    actual = (await sha256.digest(bytes)).digest
  } else if (code === IDENTITY_CODE) {
    actual = bytes
  } else {
    throw new CarVerifyError(`unsupported multihash 0x${code.toString(16)} in block ${cid}`)
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

/**
 * Check that the CAR at `carPath` is exactly the trustless-gateway answer for `root` with
 * `order=dfs&dups=n`: a single header root equal to `root`, then every block of the DAG in
 * depth-first link order, each once, each hashing to its CID (sha2-256 or identity). A
 * block out of order, an extra block, or a block the DAG needs but the CAR lacks fails.
 * Curio answers 200 with a cut-short CAR when it lacks blocks, so the last case is common.
 *
 * Only dag-pb and raw blocks are walked; another codec is {@link NotUnixfsError}.
 */
export async function verifyCar(carPath: string, root: CID): Promise<void> {
  try {
    const blocks = await CarBlockIterator.fromIterable(createReadStream(carPath))
    const roots = await blocks.getRoots()
    const headerRoot = roots[0]
    if (roots.length !== 1 || headerRoot == null || blockKey(CID.decode(headerRoot.bytes)) !== blockKey(root)) {
      throw new CarVerifyError('the CAR is not rooted at the requested CID')
    }
    const seen = new Set<string>()
    // Pre-order DFS: the next expected block is on top of the stack.
    const stack: CID[] = [root]
    for await (const block of blocks) {
      const cid = CID.decode(block.cid.bytes)
      const key = blockKey(cid)
      let expected: CID | undefined
      for (;;) {
        expected = stack.pop()
        if (expected == null) throw new CarVerifyError(`unexpected extra block ${cid}`)
        const expectedKey = blockKey(expected)
        // dups=n skips blocks already sent; identity CIDs need no block at all.
        if (seen.has(expectedKey)) continue
        if (expected.multihash.code === IDENTITY_CODE && expectedKey !== key) continue
        break
      }
      if (blockKey(expected) !== key) {
        throw new CarVerifyError(`block ${cid} arrived out of order or is not part of the DAG`)
      }
      await assertHash(cid, block.bytes)
      seen.add(key)
      stack.push(...linksOf(cid, block.bytes).reverse())
    }
    const missing = stack.find((cid) => !seen.has(blockKey(cid)) && cid.multihash.code !== IDENTITY_CODE)
    if (missing != null) {
      throw new CarVerifyError(`incomplete download: block ${missing} is missing`)
    }
  } catch (error) {
    if (error instanceof CarVerifyError || error instanceof NotUnixfsError) throw error
    throw new CarVerifyError('incomplete or malformed CAR', { cause: error })
  }
}
