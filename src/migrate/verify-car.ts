/**
 * Single-pass member download: stream a CID's CAR from a trustless gateway to
 * a file on disk while verifying it and computing its piece commitment.
 *
 * One pass over the bytes does all of:
 *   - write through to `<memberDir>/<cid>.car` (via a temp file + atomic
 *     rename, so a partial download is never mistaken for a verified member)
 *   - hash every block against its CID multihash
 *   - decode every block's links and, once the stream ends, walk the DAG from
 *     the requested root to confirm every reachable link is present (a
 *     truncated gateway response parses cleanly but fails this walk)
 *   - compute the piece commitment (CommP) and a sha256 over the exact bytes
 *
 * The bytes verified here are the bytes on disk, and later the bytes packed
 * and uploaded: there is no second fetch anywhere in the pipeline.
 */

import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
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
import { type Digest, equals } from 'multiformats/hashes/digest'
import { identity } from 'multiformats/hashes/identity'
import { sha256, sha512 } from 'multiformats/hashes/sha2'
import { log } from '../utils/cli-logger.js'
import { categoryForFetchError, failureCategoryOf, fetchCar, rootCause, StagingError } from './gateway.js'

const HASHERS: Record<number, { digest(bytes: Uint8Array): Digest<number, number> | Promise<Digest<number, number>> }> =
  {
    [identity.code]: identity,
    [sha256.code]: sha256,
    [sha512.code]: sha512,
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

async function digestMatches(cid: CID, bytes: Uint8Array): Promise<boolean> {
  const h = HASHERS[cid.multihash.code]
  if (h == null) {
    throw new StagingError(
      `no hasher for multihash code 0x${cid.multihash.code.toString(16)}; cannot verify block ${cid}`,
      'unsupported_block'
    )
  }
  return equals(cid.multihash, await h.digest(bytes))
}

function linksOf(cid: CID, bytes: Uint8Array): CID[] {
  const codec = CODECS[cid.code]
  if (codec == null) {
    throw new StagingError(`no codec for 0x${cid.code.toString(16)} in block ${cid}`, 'unsupported_block')
  }
  const block = createUnsafe({ cid, bytes, codec }) as BlockView
  return Array.from(block.links(), ([, linked]) => linked as CID)
}

export interface VerifiedCar {
  /** PieceCID v2 over the exact CAR bytes. */
  pieceCid: string
  /** CAR byte length. */
  rawSize: number
  /** sha256 of the same bytes, for resume re-verification. */
  sha256: string
  /** Blocks hash-checked, including any not reachable from the root. */
  blockCount: number
}

export interface VerifyCarOptions {
  /**
   * Called with each chunk's byte length before the chunk is hashed or
   * written. Throwing drops that chunk and aborts the verification with that
   * error: the disk-budget gate uses this to cut off a download that would
   * overrun the staging budget.
   */
  onBytes?: ((delta: number) => void) | undefined
}

interface CarSink {
  write(chunk: Uint8Array): Promise<void>
  end(): Promise<void>
}

/**
 * Stream a CAR through the piece hasher, a sha256 tap, block verification,
 * and the sink in one pass, then walk the DAG from `root` and reject any
 * reachable link the CAR does not contain. `root` is matched against the
 * declared roots by multihash, because the trustless-gateway spec lets a
 * CIDv0 request be answered with the CIDv1 root; the codec check in the walk
 * rejects a relabeled root.
 */
export async function verifyCarStream(
  body: ReadableStream<Uint8Array>,
  root: CID,
  sink: CarSink,
  opts: VerifyCarOptions = {}
): Promise<VerifiedCar> {
  const pieceHasher = hasher()
  const sha = createHash('sha256')
  let rawSize = 0
  // An error raised inside the tap (budget cutoff, sink failure, dead socket)
  // surfaces through the CAR decoder; it must win over the decoder's own error.
  let tapError: unknown

  async function* tap(): AsyncIterable<Uint8Array> {
    const reader = body.getReader()
    try {
      for (;;) {
        let next: ReadableStreamReadResult<Uint8Array>
        try {
          next = await reader.read()
        } catch (err) {
          throw new StagingError(`gateway stream failed: ${rootCause(err)}`, categoryForFetchError(err), { cause: err })
        }
        if (next.done) return
        const chunk = next.value
        opts.onBytes?.(chunk.length)
        pieceHasher.write(chunk)
        sha.update(chunk)
        rawSize += chunk.length
        await sink.write(chunk)
        yield chunk
      }
    } catch (err) {
      tapError = err
      throw err
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }

  /**
   * Present blocks and their outgoing links, keyed by multihash bytes. The
   * codec the CAR entry declared is kept alongside: links were decoded with
   * it, so a walk that reaches the same multihash under a different codec
   * must not trust them (see the codec check below).
   */
  const present = new Map<string, { code: number; links: CID[] }>()
  let blockCount = 0

  // The decoder pulls the tap but never returns it, so a failure anywhere
  // below would leave the generator suspended holding the body's lock.
  const chunks = tap()
  try {
    const reader = await CarBlockIterator.fromIterable(chunks)
    // The header is parsed by now. Reject a response for the wrong DAG before
    // spending bandwidth on its blocks.
    const rootKey = blockKey(root)
    const roots = await reader.getRoots()
    if (!roots.some((r) => blockKey(r) === rootKey)) {
      throw new StagingError(
        `CAR root mismatch: expected ${root.toString()}, CAR declares [${roots.map((r) => r.toString()).join(', ')}]`,
        'car_root_mismatch'
      )
    }
    for await (const block of reader) {
      const cid = block.cid
      if (!(await digestMatches(cid, block.bytes))) {
        throw new StagingError(`block ${cid.toString()} does not match its multihash`, 'car_block_mismatch')
      }
      present.set(blockKey(cid), { code: cid.code, links: linksOf(cid, block.bytes) })
      blockCount++
    }
  } catch (err) {
    if (tapError != null) throw tapError
    if (err instanceof StagingError) throw err
    // The decoder ran out of bytes mid-block: a response cut off by the gateway.
    throw new StagingError(`CAR decode failed: ${rootCause(err)}`, 'car_incomplete', { cause: err })
  } finally {
    await (chunks as AsyncGenerator<Uint8Array>).return(undefined)
  }
  await sink.end()

  // Completeness: every link reachable from the root must be present. A
  // response that ended early at a block boundary parses cleanly and fails
  // exactly here.
  const seen = new Set<string>()
  const stack: CID[] = [root]
  for (let cid = stack.pop(); cid != null; cid = stack.pop()) {
    const key = blockKey(cid)
    if (seen.has(key)) continue
    seen.add(key)
    if (cid.multihash.code === identity.code) {
      // Identity blocks carry their bytes in the digest and are not written
      // to the CAR; their links still count toward completeness.
      stack.push(...linksOf(cid, cid.multihash.digest))
      continue
    }
    const entry = present.get(key)
    if (entry == null) {
      throw new StagingError(
        `CAR is incomplete: block ${cid.toString()} is reachable from the root but missing`,
        'car_incomplete'
      )
    }
    // A block that arrived under a different codec than the walk reached it
    // by had its links decoded with the wrong decoder. Accepting it would
    // let a gateway relabel the root bytes as `raw` (no links) and pass the
    // completeness walk on a truncated DAG.
    if (entry.code !== cid.code) {
      throw new StagingError(
        `block ${cid.toString()} arrived with codec 0x${entry.code.toString(16)} but is referenced ` +
          `with codec 0x${cid.code.toString(16)}`,
        'car_block_mismatch'
      )
    }
    stack.push(...entry.links)
  }

  return { pieceCid: pieceHasher.finalize().toString(), rawSize, sha256: sha.digest('hex'), blockCount }
}

export interface FileSink extends CarSink {
  /** Close the descriptor after a failure so the temp file can unlink (Windows holds EBUSY otherwise). */
  destroy(): Promise<void>
}

/** File-backed sink for `verifyCarStream`. A write error fails the next write or `end()`. */
export function createFileSink(filePath: string): FileSink {
  const stream = createWriteStream(filePath)
  const done = finished(stream)
  done.catch(() => undefined) // observed by end(); a failure before then is not an unhandled rejection
  return {
    async write(chunk) {
      // `once` rejects on 'error', so a disk failure under backpressure cannot hang here.
      if (!stream.write(chunk)) await once(stream, 'drain')
    },
    async end() {
      stream.end()
      await done
    },
    async destroy() {
      // The open is async: unlinking before it completes would leave a fresh empty file behind.
      if (stream.closed) return
      stream.destroy()
      await once(stream, 'close')
    },
  }
}

export interface StagedMember {
  /** The CID as requested. */
  cid: string
  /** PieceCID v2 of the member CAR. */
  pieceCid: string
  /** Member CAR byte length. */
  rawSize: number
  /** The gateway that served the verified CAR. */
  gateway: string
  /** The exact URL fetched. */
  url: string
  /** `<memberDir>/<cid>.car`. */
  memberCarPath: string
  /** sha256 of the member CAR, for resume re-verification. */
  memberSha256: string
}

/** The fetch surface `stageMember` drives; injectable for network-free tests. */
export type CarFetcher = (gateway: string, cid: string) => Promise<{ url: string; body: ReadableStream<Uint8Array> }>

// Another gateway cannot fix these; rethrow at once instead of re-downloading.
const LOCAL_CATEGORIES = new Set(['staging_budget', 'unsupported_block'])

/**
 * Download one CID from the first working gateway, verify it, and land it as
 * `<memberDir>/<cid>.car` via a temp file and atomic rename. Tries gateways
 * in order; the first whose CAR verifies wins. A failure another gateway
 * cannot fix (budget cutoff, unsupported block, local I/O) rethrows at once.
 */
export async function stageMember(
  cid: string,
  gateways: string[],
  memberDir: string,
  opts: VerifyCarOptions = {},
  fetcher: CarFetcher = fetchCar
): Promise<StagedMember> {
  const root = CID.parse(cid)
  const finalPath = join(memberDir, `${cid}.car`)
  // Fixed name: createWriteStream truncates, so a retry overwrites a crash orphan.
  const tmpPath = join(memberDir, `${cid}.car.tmp`)
  const attempts: Array<{ gateway: string; error: Error }> = []

  for (const gateway of gateways) {
    let sink: FileSink | null = null
    try {
      const { url, body } = await fetcher(gateway, cid)
      sink = createFileSink(tmpPath)
      const verified = await verifyCarStream(body, root, sink, opts)
      await rename(tmpPath, finalPath)
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
      await sink?.destroy()
      await unlink(tmpPath).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') log.warn(`could not remove ${tmpPath}: ${e.code ?? e.message}`)
      })
      if (!(err instanceof StagingError) || LOCAL_CATEGORIES.has(err.category)) throw err
      attempts.push({ gateway, error: err })
      log.warn(`${cid} via ${gateway} failed: ${err.message}`)
    }
  }

  const category = attempts.map((a) => failureCategoryOf(a.error)).find((c) => c !== 'other') ?? 'other'
  throw new StagingError(
    `all gateways failed for ${cid}\n    ${attempts.map((a) => `${a.gateway}: ${a.error.message}`).join('\n    ')}`,
    category,
    { cause: attempts.map((a) => a.error) }
  )
}
