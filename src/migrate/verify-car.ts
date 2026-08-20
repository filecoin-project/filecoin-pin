/**
 * Single-pass member download: stream a CID's CAR from a trustless gateway to
 * a file on disk while verifying it and computing its piece commitment.
 *
 * One pass over the bytes does all of:
 *   - write through to `<memberDir>/<cid>.car` (via a temp file + atomic
 *     rename, so a partial download is never mistaken for a verified member)
 *   - hash every block against its CID multihash
 *   - decode every block's links and, once the stream ends, walk the DAG from
 *     the root to confirm every reachable link is present (a truncated
 *     gateway response parses cleanly but fails this walk)
 *   - compute the piece commitment (CommP) and a sha256 over the exact bytes
 *
 * The bytes verified here are the bytes on disk, and later the bytes packed
 * and uploaded: there is no second fetch anywhere in the pipeline.
 */

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { hasher } from '@filoz/synapse-core/piece'
import { CarBlockIterator } from '@ipld/car'
import * as dagCbor from '@ipld/dag-cbor'
import * as dagPb from '@ipld/dag-pb'
import { base64 } from 'multiformats/bases/base64'
import { createUnsafe } from 'multiformats/block'
import type { BlockView } from 'multiformats/block/interface'
import { CID } from 'multiformats/cid'
import * as json from 'multiformats/codecs/json'
import * as raw from 'multiformats/codecs/raw'
import { sha256, sha512 } from 'multiformats/hashes/sha2'
import type { FailureCategory } from './db.js'
import { fetchCar, GatewayError } from './gateway.js'
import { log } from './util.js'

/**
 * Error thrown by the verify path, carrying a failure category alongside the
 * message, mirroring `GatewayError`.
 */
export class VerifyCarError extends Error {
  category: FailureCategory
  constructor(message: string, category: FailureCategory) {
    super(message)
    this.name = 'VerifyCarError'
    this.category = category
  }
}

/** Read a category off a thrown error, falling back to `other`. */
export function categoryOf(err: unknown): FailureCategory {
  if (err instanceof GatewayError) return err.category
  if (err instanceof VerifyCarError) return err.category
  return 'other'
}

const IDENTITY_MULTIHASH_CODE = 0x0
const SHA2_256_CODE = 0x12
const SHA2_512_CODE = 0x13

const HASHERS: Record<number, { digest(b: Uint8Array): { digest: Uint8Array } | Promise<{ digest: Uint8Array }> }> = {
  [SHA2_256_CODE]: sha256,
  [SHA2_512_CODE]: sha512,
}

/**
 * Codecs a trustless UnixFS/IPLD CAR carries. An unknown codec fails the
 * verification rather than silently skipping a block's links: skipped links
 * would defeat the completeness walk.
 */
const CODECS: Record<number, { code: number; decode(bytes: Uint8Array): unknown }> = {
  [dagPb.code]: dagPb,
  [dagCbor.code]: dagCbor,
  [raw.code]: raw,
  [json.code]: json,
}

/** Exact key: the multihash bytes, so CIDv0/v1 forms of a block collapse. */
function blockKey(cid: CID): string {
  return base64.encode(cid.multihash.bytes)
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

async function digestMatches(cid: CID, bytes: Uint8Array): Promise<boolean> {
  const code = cid.multihash.code
  if (code === IDENTITY_MULTIHASH_CODE) return bytesEqual(bytes, cid.multihash.digest)
  const h = HASHERS[code]
  if (h == null) {
    throw new VerifyCarError(`no hasher for multihash code 0x${code.toString(16)}; cannot verify block ${cid}`, 'other')
  }
  const { digest } = await h.digest(bytes)
  return bytesEqual(digest, cid.multihash.digest)
}

function linksOf(cid: CID, bytes: Uint8Array): CID[] {
  const codec = CODECS[cid.code]
  if (codec == null) {
    throw new VerifyCarError(`no codec for 0x${cid.code.toString(16)} in block ${cid}`, 'other')
  }
  const block = createUnsafe({ cid, bytes, codec }) as BlockView
  const links: CID[] = []
  for (const [, linked] of block.links()) {
    links.push(linked as CID)
  }
  return links
}

export interface VerifiedCar {
  /** PieceCID v2 over the exact CAR bytes. */
  pieceCid: string
  /** CAR byte length. */
  rawSize: number
  /** sha256 of the same bytes, for resume re-verification. */
  sha256: string
  roots: CID[]
  blockCount: number
}

export interface VerifyCarOptions {
  /**
   * Called with each chunk's byte length as it is written. Throwing aborts
   * the verification with that error: the disk-budget gate uses this to cut
   * off a download that would overrun the staging budget.
   */
  onBytes?: ((delta: number) => void) | undefined
  /**
   * Root the completeness walk starts from. Without it the first declared
   * root is walked, which is not enough when the caller requested a specific
   * CID: a response could declare an unrelated-but-complete first root and
   * an incomplete requested one.
   */
  expectedRoot?: CID | undefined
}

/**
 * Stream a CAR through the piece hasher, a sha256 tap, block verification,
 * and the sink in one pass, then walk the DAG from the first root and reject
 * any reachable link the CAR does not contain.
 */
export async function verifyCarStream(
  body: ReadableStream<Uint8Array>,
  sink: { write(chunk: Uint8Array): Promise<void>; end(): Promise<void> },
  opts: VerifyCarOptions = {}
): Promise<VerifiedCar> {
  const pieceHasher = hasher()
  const sha = createHash('sha256')
  let rawSize = 0

  async function* tap(): AsyncIterable<Uint8Array> {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      opts.onBytes?.(chunk.length)
      pieceHasher.write(chunk)
      sha.update(chunk)
      rawSize += chunk.length
      await sink.write(chunk)
      yield chunk
    }
  }

  /**
   * Present blocks and their outgoing links, keyed by multihash bytes. The
   * codec the CAR entry declared is kept alongside: links were decoded with
   * it, so a walk that reaches the same multihash under a different codec
   * must not trust them (see the codec check below).
   */
  const links = new Map<string, { code: number; links: CID[] }>()
  let blockCount = 0

  const reader = await CarBlockIterator.fromIterable(tap())
  for await (const block of reader) {
    const cid = block.cid
    if (!(await digestMatches(cid, block.bytes))) {
      throw new VerifyCarError(`block ${cid.toString()} does not match its multihash`, 'car_block_mismatch')
    }
    links.set(blockKey(cid), { code: cid.code, links: linksOf(cid, block.bytes) })
    blockCount++
  }
  const roots = await reader.getRoots()
  await sink.end()

  // Completeness: every link reachable from the root must be present. A
  // response that ended early at a block boundary parses cleanly and fails
  // exactly here.
  const root = opts.expectedRoot ?? roots[0]
  if (root == null) {
    throw new VerifyCarError('CAR declares no roots', 'car_incomplete')
  }
  const seen = new Set<string>()
  const stack: CID[] = [root]
  while (stack.length > 0) {
    const cid = stack.pop()
    if (cid == null) break
    const key = blockKey(cid)
    if (seen.has(key)) continue
    seen.add(key)
    if (cid.multihash.code === IDENTITY_MULTIHASH_CODE) {
      // Identity blocks carry their bytes in the digest and are not written
      // to the CAR; their links still count toward completeness.
      stack.push(...linksOf(cid, cid.multihash.digest))
      continue
    }
    const entry = links.get(key)
    if (entry == null) {
      throw new VerifyCarError(
        `CAR is incomplete: block ${cid.toString()} is reachable from the root but missing`,
        'car_incomplete'
      )
    }
    // A block that arrived under a different codec than the walk reached it
    // by had its links decoded with the wrong decoder. Accepting it would
    // let a gateway relabel the root bytes as `raw` (no links) and pass the
    // completeness walk on a truncated DAG.
    if (entry.code !== cid.code) {
      throw new VerifyCarError(
        `block ${cid.toString()} arrived with codec 0x${entry.code.toString(16)} but is referenced ` +
          `with codec 0x${cid.code.toString(16)}`,
        'car_block_mismatch'
      )
    }
    stack.push(...entry.links)
  }

  return { pieceCid: pieceHasher.finalize().toString(), rawSize, sha256: sha.digest('hex'), roots, blockCount }
}

export interface FileSink {
  write(chunk: Uint8Array): Promise<void>
  end(): Promise<void>
  /** Release the descriptor after a failure so the temp file can unlink (Windows holds EBUSY otherwise). */
  destroy(): void
}

/** File-backed sink for `verifyCarStream`; unlinks the partial file on failure. */
export function createFileSink(filePath: string): FileSink {
  const stream = createWriteStream(filePath)
  let firstError: Error | null = null
  stream.on('error', (err) => {
    if (firstError == null) firstError = err
  })
  return {
    write(chunk) {
      if (firstError != null) return Promise.reject(firstError)
      return new Promise<void>((resolve, reject) => {
        // A buffered write resolves immediately; a flush failure lands in
        // `firstError` via the error listener and fails the next write or
        // end(). Only backpressure defers, and then to `drain`, not to the
        // flush callback: waiting out the flush per chunk would serialize
        // the whole download on disk latency.
        const ok = stream.write(chunk, (err) => {
          if (err) reject(err)
        })
        if (ok) resolve()
        else stream.once('drain', resolve)
      })
    },
    async end() {
      if (firstError != null) throw firstError
      await new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => (err ? reject(err) : resolve()))
      })
      if (firstError != null) throw firstError
    },
    destroy() {
      stream.destroy()
    },
  }
}

export interface StagedMember {
  cid: string
  pieceCid: string
  rawSize: number
  gateway: string
  url: string
  memberCarPath: string
  memberSha256: string
}

/** The fetch surface `stageMember` drives; injectable for network-free tests. */
export type CarFetcher = (gateway: string, cid: string) => Promise<{ url: string; body: ReadableStream<Uint8Array> }>

/**
 * Download one CID from the first working gateway, verify it, and land it as
 * `<memberDir>/<cid>.car` via a temp file and atomic rename. Tries gateways
 * in order; the first whose CAR verifies wins.
 */
export async function stageMember(
  cid: string,
  gateways: string[],
  memberDir: string,
  opts: VerifyCarOptions = {},
  fetcher: CarFetcher = fetchCar
): Promise<StagedMember> {
  const expected = CID.parse(cid)
  const finalPath = join(memberDir, `${cid}.car`)
  const errors: string[] = []
  const categories: FailureCategory[] = []

  for (const gateway of gateways) {
    const tmpPath = join(memberDir, `${cid}.car.tmp-${process.pid}`)
    let body: ReadableStream<Uint8Array> | null = null
    let sink: FileSink | null = null
    try {
      const fetched = await fetcher(gateway, cid)
      const url = fetched.url
      body = fetched.body
      sink = createFileSink(tmpPath)
      // The completeness walk must start from the CID the caller asked for,
      // not whatever root the response happens to declare first.
      const verified = await verifyCarStream(body, sink, { ...opts, expectedRoot: expected })
      // Roots compare by multihash: the trustless-gateway spec permits
      // answering a CIDv0 request with the equivalent CIDv1 root, and the
      // walk's codec check above already rejects a relabeled root.
      if (!verified.roots.some((r) => blockKey(r) === blockKey(expected))) {
        throw new VerifyCarError(
          `CAR root mismatch: expected ${cid}, CAR declares [${verified.roots.map((r) => r.toString()).join(', ')}]`,
          'car_root_mismatch'
        )
      }
      await rename(tmpPath, finalPath)
      log(`  ok ${cid} (${verified.rawSize} bytes, ${verified.blockCount} block(s) verified) via ${gateway}`)
      return {
        cid,
        pieceCid: verified.pieceCid,
        rawSize: verified.rawSize,
        gateway,
        url,
        memberCarPath: finalPath,
        memberSha256: verified.sha256,
      }
    } catch (err) {
      // Release the descriptor and the HTTP connection before the unlink:
      // an open handle blocks deletion on Windows, and an unconsumed body
      // holds the socket until GC.
      sink?.destroy()
      await body?.cancel().catch(() => undefined)
      await unlink(tmpPath).catch(() => undefined)
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`${gateway}: ${message}`)
      categories.push(categoryOf(err))
      log(`  ! ${cid} via ${gateway} failed: ${message}`)
      // A budget cutoff is not a gateway problem; do not burn the other
      // gateways on it.
      if (categoryOf(err) === 'staging_budget') {
        throw err
      }
    }
  }

  const aggregated = categories.find((c) => c !== 'other') ?? 'other'
  throw new VerifyCarError(`all gateways failed for ${cid}\n    ${errors.join('\n    ')}`, aggregated)
}
