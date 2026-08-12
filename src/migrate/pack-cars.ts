/**
 * Pack multiple source CIDs into one multi-root CAR sub-piece.
 *
 * Uploading one piece per source CID caps throughput on per-piece overhead
 * (store round-trips, addPieces batch slots). Packing groups M source CIDs
 * into one synthetic multi-root CAR and uploads that CAR as a single piece;
 * the number of pieces (and the number of addPieces slots) drops by ~M.
 *
 * Pack stage:
 *   1. Sort source pieces by parsed CID bytes (CIDv0 and CIDv1 of the same DAG
 *      collapse). The sort order pins the multi-root CAR's bytes.
 *   2. Largest-first bin pack under `--pack-target-size` (raw bytes, not
 *      padded). A piece whose own raw size exceeds the target ships alone in
 *      its own bin, as long as it fits one uploadable piece; anything over the
 *      SDK's per-piece upload cap genuinely cannot migrate on this path.
 *   3. Inside each pack plan, reject if a member CID appears twice:
 *      Curio's indexer collapses duplicate `(piece_cid, payload_multihash)`
 *      rows, so a collision would silently lose one copy.
 *
 * Build stage (one bin at a time):
 *   - Re-fetch each member CAR in canonical order via the block-verified
 *     canonical path (`gateway-blocks.ts`): the same serialization the commP
 *     pass hashed, so a truncated gateway response can never silently drop
 *     blocks from the assembled piece.
 *   - Walk it via `@ipld/car`'s `CarBlockIterator`; rejecting any zero-length
 *     section catches the truncation hazard in Curio's indexer
 *     (`ZeroLengthSectionAsEOF(true)`).
 *   - Re-emit through `CarWriter` (single multi-root header + deterministic
 *     `varint(len) || cid || data` framing).
 *   - Tee bytes into the piece hasher and a sha256 digest, and write through
 *     to a file under the staging directory.
 *   - Record the sub-piece row (with members) atomically once the assembled
 *     commitment is computed and the file is on disk.
 */

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { hasher } from '@filoz/synapse-core/piece'
import { SIZE_CONSTANTS } from '@filoz/synapse-sdk'
import { CarBlockIterator, CarWriter } from '@ipld/car'
import { CID } from 'multiformats/cid'
import type { MigrationDB, PieceRow } from './db.js'
import { fetchCanonicalCar } from './gateway-blocks.js'
import { log } from './util.js'

/**
 * Default target raw size for one assembled sub-piece. 1016 MiB is the SDK's
 * per-piece cap; 1000 MiB leaves headroom for the multi-root CAR header and
 * framing the bin-packing weight ignores.
 */
export const DEFAULT_PACK_TARGET_BYTES = 1000n * 1024n * 1024n

/** The SDK's per-piece upload cap (1016 MiB). */
export const MAX_UPLOAD_BYTES = SIZE_CONSTANTS.MAX_UPLOAD_SIZE

export interface PackPlanInput {
  /** Source CID. */
  cid: string
  /** Raw CAR size in bytes: used as the bin-packing weight. */
  rawSize: number
}

export interface PackedBin {
  /** Member CIDs in the canonical (parsed-bytes ascending) order. */
  memberCids: string[]
  /** Sum of member raw sizes. Used as the planning weight, not the final CAR length. */
  totalRawSize: number
}

/**
 * Compare two CID strings by their parsed binary form. CIDv0 (`Qm...`) and
 * CIDv1 (`baf...`) of the same DAG produce wildly different lexicographic
 * orderings on the string form; comparing parsed bytes collapses that alias so
 * a single canonical ordering exists regardless of which form the source CID
 * was registered as.
 */
export function compareCidBytes(a: string, b: string): number {
  const ba = CID.parse(a).bytes
  const bb = CID.parse(b).bytes
  const len = Math.min(ba.length, bb.length)
  for (let i = 0; i < len; i += 1) {
    const xa = ba[i] ?? 0
    const xb = bb[i] ?? 0
    if (xa !== xb) {
      return xa - xb
    }
  }
  return ba.length - bb.length
}

/**
 * Largest-first bin pack under `targetSizeBytes` (raw bytes). Pieces above the
 * target on their own are returned in the `oversized` list so the caller can
 * ship each as a single-member bin (or refuse it past the upload cap). Within
 * each bin the members are emitted in canonical sort order.
 */
export function planBins(
  pieces: PackPlanInput[],
  targetSizeBytes: number
): { bins: PackedBin[]; oversized: PackPlanInput[] } {
  if (targetSizeBytes <= 0) {
    throw new Error(`pack target size must be > 0 (got ${targetSizeBytes})`)
  }
  // Reject the CID collision up-front: the same source CID appearing twice in
  // the plan would collapse to one indexed entry on the provider side.
  // Higher-level callers should de-duplicate the input.
  const seen = new Set<string>()
  for (const p of pieces) {
    if (seen.has(p.cid)) {
      throw new Error(`duplicate source CID in pack plan: ${p.cid}`)
    }
    seen.add(p.cid)
  }

  const oversized: PackPlanInput[] = []
  const fits = pieces.filter((p) => {
    if (p.rawSize > targetSizeBytes) {
      oversized.push(p)
      return false
    }
    return true
  })
  // Largest first: keeps the bin count down.
  const sorted = [...fits].sort((a, b) => b.rawSize - a.rawSize)
  const bins: Array<{ pieces: PackPlanInput[]; used: number }> = []
  for (const piece of sorted) {
    let placed = false
    for (const bin of bins) {
      if (bin.used + piece.rawSize <= targetSizeBytes) {
        bin.pieces.push(piece)
        bin.used += piece.rawSize
        placed = true
        break
      }
    }
    if (!placed) {
      bins.push({ pieces: [piece], used: piece.rawSize })
    }
  }
  return {
    bins: bins.map((b) => ({
      memberCids: b.pieces.map((p) => p.cid).sort(compareCidBytes),
      totalRawSize: b.used,
    })),
    oversized,
  }
}

/**
 * Sink shape that `assembleMultiRootCar` writes through. The file-store
 * implementation writes through to disk; tests can pass an in-memory stand-in
 * to verify the assembly without touching the filesystem.
 */
export interface WritableStreamWithLength {
  write(chunk: Uint8Array): Promise<void>
  end(): Promise<void>
}

/**
 * Build a multi-root CAR from a list of member CARs.
 *
 * The result is fully streamed: the function writes `Uint8Array` chunks to the
 * sink as blocks become available, computes the assembled PieceCID v2, the
 * assembled sha256, and the total byte length, and verifies every member CAR's
 * bytes by walking the `CarBlockIterator`. A zero-length section in any member
 * causes a hard rejection: the provider's indexer would silently truncate the
 * rest of the block stream (`ZeroLengthSectionAsEOF(true)`).
 */
export async function assembleMultiRootCar(
  memberStreams: Array<{ cid: string; body: ReadableStream<Uint8Array> }>,
  sink: WritableStreamWithLength
): Promise<{ pieceCid: string; assembledBytes: number; sha256: string; roots: string[] }> {
  // Walk each member CAR first to surface its roots and validate the block
  // stream (rejecting zero-length sections). Then re-emit through CarWriter so
  // the output is one deterministic multi-root CAR.
  const roots: CID[] = []
  const blockRuns: Array<{ cid: CID; bytes: Uint8Array }[]> = []
  for (const member of memberStreams) {
    const expected = CID.parse(member.cid)
    const reader = await CarBlockIterator.fromIterable(toAsyncIterable(member.body))
    const blocks: Array<{ cid: CID; bytes: Uint8Array }> = []
    for await (const block of reader) {
      if (block.bytes.length === 0) {
        // Curio's indexer treats a zero-length block section as EOF and stops
        // walking the rest of the CAR; the missing blocks never become
        // retrievable. Refuse to assemble such a member.
        throw new Error(
          `member ${member.cid}: zero-length block section at cid ${block.cid.toString()}: indexer would truncate`
        )
      }
      blocks.push({ cid: block.cid, bytes: block.bytes })
    }
    const memberRoots = await reader.getRoots()
    if (!memberRoots.some((r) => r.equals(expected) || r.toString() === member.cid)) {
      throw new Error(
        `member ${member.cid}: CAR root mismatch: declares [${memberRoots.map((r) => r.toString()).join(', ')}]`
      )
    }
    roots.push(expected)
    blockRuns.push(blocks)
  }

  const { writer, out } = CarWriter.create(roots)
  const pieceHasher = hasher()
  const sha = createHash('sha256')
  let assembledBytes = 0

  const drained = (async () => {
    for await (const chunk of out) {
      pieceHasher.write(chunk)
      sha.update(chunk)
      assembledBytes += chunk.length
      await sink.write(chunk)
    }
  })()

  for (const run of blockRuns) {
    for (const block of run) {
      await writer.put(block)
    }
  }
  await writer.close()
  await drained
  await sink.end()

  const pieceCid = pieceHasher.finalize().toString()
  return {
    pieceCid,
    assembledBytes,
    sha256: sha.digest('hex'),
    roots: roots.map((r) => r.toString()),
  }
}

async function* toAsyncIterable(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    yield chunk
  }
}

/**
 * Stream-write sink backed by a file under the staging directory. The file is
 * flushed via the regular WriteStream `end`; a write or open failure unlinks
 * the partial file and surfaces the original error.
 */
export function createCarStoreSink(filePath: string): WritableStreamWithLength {
  const stream = createWriteStream(filePath)
  let firstError: Error | null = null
  let cleanupDone = false
  const unlinkPartial = async () => {
    if (cleanupDone) return
    cleanupDone = true
    // The file may not exist (createWriteStream's open failed) or may be
    // partially written. unlink errors are swallowed: the failure we surface
    // is the write/open error, not the cleanup error.
    await unlink(filePath).catch(() => undefined)
  }
  stream.on('error', (err) => {
    if (firstError == null) firstError = err
    void unlinkPartial()
  })
  return {
    write(chunk) {
      if (firstError != null) return Promise.reject(firstError)
      return new Promise<void>((resolve, reject) => {
        if (firstError != null) {
          reject(firstError)
          return
        }
        const onError = (err: Error) => reject(err)
        stream.once('error', onError)
        const cleanup = () => stream.off('error', onError)
        const ok = stream.write(chunk, (err) => {
          cleanup()
          if (err) reject(err)
          else if (ok) resolve()
        })
        if (!ok)
          stream.once('drain', () => {
            cleanup()
            resolve()
          })
      })
    },
    async end() {
      if (firstError != null) {
        await unlinkPartial()
        throw firstError
      }
      await new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => (err ? reject(err) : resolve()))
      }).catch(async (err) => {
        await unlinkPartial()
        throw err
      })
    },
  }
}

export interface PackCarsOptions {
  /** Source-CAR gateways, used to re-fetch member CARs during assembly. */
  gateways: string[]
  /** Per-sub-piece raw-size budget. Default `DEFAULT_PACK_TARGET_BYTES`. */
  targetSizeBytes?: number
  /** Directory under which assembled CAR files are persisted. */
  carStore: string
}

export interface PackCarsSummary {
  bins: number
  built: number
  failed: number
  /** Source CIDs skipped because they exceed the per-piece upload cap. */
  overCap: string[]
  /**
   * Source CIDs whose bin failed to assemble. They stay `done` and re-enter the
   * free pool on the next run (a transient gateway flap recovers); a CID that
   * keeps reappearing here across runs has a permanent assembly problem the
   * operator must investigate. Surfaced per-CID because `failed` counts bins,
   * not CIDs.
   */
  failedMemberCids: string[]
}

/** The bin assembler `runPackCars` drives; injectable so the pack loop's
 *  success/failure accounting is testable without re-fetching member CARs. */
export type BinBuilder = (
  bin: PackedBin,
  carStore: string,
  gateways: string[]
) => Promise<{ pieceCid: string; assembledBytes: number; sha256: string; filePath: string }>

/**
 * Drive the pack stage end-to-end: bin the free `done` pieces, assemble each
 * bin to disk, record each sub-piece row. Idempotent: re-running picks up
 * only pieces not yet locked into a sub-piece.
 */
export async function runPackCars(
  db: MigrationDB,
  opts: PackCarsOptions,
  buildBin: BinBuilder = buildOneBin
): Promise<PackCarsSummary> {
  const target = opts.targetSizeBytes ?? Number(DEFAULT_PACK_TARGET_BYTES)
  if (target > MAX_UPLOAD_BYTES) {
    throw new Error(`--pack-target-size ${target} exceeds the per-piece upload cap ${MAX_UPLOAD_BYTES}`)
  }
  await mkdir(opts.carStore, { recursive: true })

  // Snapshot the free pieces once. planBins partitions them into disjoint
  // bins, so the member-size map built here stays valid for every bin even as
  // each recordBuiltSubPiece locks its own members: a later bin never
  // references a CID an earlier bin already claimed.
  const free = db.donePiecesFreeForPacking()
  const piecesByCid = new Map<string, PieceRow>(free.map((p) => [p.cid, p]))
  const inputsForBuild: PackPlanInput[] = free.map((p) => ({
    cid: p.cid,
    rawSize: p.rawSize ?? 0,
  }))
  const { bins, oversized } = planBins(inputsForBuild, target)

  // An oversized-for-bin piece still ships as a CAR file, alone in its own
  // bin, as long as it fits one uploadable piece. Anything over the per-piece
  // cap genuinely cannot migrate on this path.
  const overCap: string[] = []
  for (const p of oversized) {
    if (p.rawSize > MAX_UPLOAD_BYTES) {
      log(`! ${p.cid} (${p.rawSize} bytes) exceeds the ${MAX_UPLOAD_BYTES}-byte upload cap; not migrated`)
      overCap.push(p.cid)
      continue
    }
    bins.push({ memberCids: [p.cid], totalRawSize: p.rawSize })
  }

  const summary: PackCarsSummary = { bins: bins.length, built: 0, failed: 0, overCap, failedMemberCids: [] }
  for (const bin of bins) {
    try {
      const built = await buildBin(bin, opts.carStore, opts.gateways)
      // One transaction inserts the sub_piece row in `built` status alongside
      // its members. A crash anywhere before this returns leaves no partial DB
      // state: the CAR file on disk is the only stranded artifact, and the
      // next pack pass can rebuild and replace it.
      db.recordBuiltSubPiece({
        subPieceCid: built.pieceCid,
        assembledCarLength: built.assembledBytes,
        targetSizeBytes: target,
        carPath: built.filePath,
        assembledSha256: built.sha256,
        members: bin.memberCids.map((cid) => ({
          cid,
          rawSize: piecesByCid.get(cid)?.rawSize ?? null,
          sha256: null,
        })),
      })
      log(`  + sub-piece ${built.pieceCid} (${built.assembledBytes} bytes, ${bin.memberCids.length} member(s))`)
      summary.built += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Surface which source CIDs failed to pack: `failed` alone counts bins,
      // not CIDs, so without this the operator can't tell what didn't migrate.
      // No DB write: the members stay `done` and a transient failure recovers
      // on the next run; a CID that keeps failing here is a permanent problem
      // to investigate, not a silent drop.
      summary.failedMemberCids.push(...bin.memberCids)
      log(`  ! sub-piece build failed (${bin.memberCids.length} member(s): ${bin.memberCids.join(', ')}): ${message}`)
      summary.failed += 1
    }
  }

  return summary
}

/**
 * Fetch a member CAR via the canonical block-verified path, trying each
 * gateway in order until one yields a body. A single gateway flap must not
 * fail the whole bin when fallbacks are configured.
 */
async function fetchCarFromAnyGateway(gateways: string[], cid: string): Promise<{ body: ReadableStream<Uint8Array> }> {
  const errors: string[] = []
  for (const gateway of gateways) {
    try {
      return await fetchCanonicalCar(gateway, cid)
    } catch (err) {
      errors.push(`${gateway}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(`all gateways failed for ${cid}: ${errors.join('; ')}`)
}

async function buildOneBin(
  bin: PackedBin,
  carStore: string,
  gateways: string[]
): Promise<{ pieceCid: string; assembledBytes: number; sha256: string; filePath: string }> {
  // Fetch lazily, one member at a time. Pre-fetching all member streams in
  // parallel keeps the later ones idle while the first is consumed; the
  // gateway closes those idle response bodies after its inactivity timeout
  // and the consumer sees `Unexpected end of data`. Streaming each member in
  // turn keeps every response under active read. The assembler iterates
  // `memberStreams` sequentially, so each body materialises just before its
  // bytes are read.
  const memberStreams: Array<{ cid: string; body: ReadableStream<Uint8Array> }> = bin.memberCids.map((cid) => {
    let lazy: ReadableStream<Uint8Array> | null = null
    return {
      cid,
      get body(): ReadableStream<Uint8Array> {
        if (lazy != null) return lazy
        const promise = fetchCarFromAnyGateway(gateways, cid).then((r) => r.body)
        lazy = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              const body = await promise
              const reader = body.getReader()
              while (true) {
                const { value, done } = await reader.read()
                if (done) break
                controller.enqueue(value)
              }
              controller.close()
            } catch (err) {
              controller.error(err)
            }
          },
        })
        return lazy
      },
    }
  })

  const tmpName = `pack-${process.pid}-${Date.now()}.car`
  const tmpPath = path.join(carStore, tmpName)
  const sink = createCarStoreSink(tmpPath)
  try {
    const result = await assembleMultiRootCar(memberStreams, sink)
    const finalPath = path.join(carStore, `${result.pieceCid}.car`)
    // Rename through the same directory so it's an atomic move on local FS.
    await rename(tmpPath, finalPath)
    return {
      pieceCid: result.pieceCid,
      assembledBytes: result.assembledBytes,
      sha256: result.sha256,
      filePath: finalPath,
    }
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined)
    throw err
  }
}
