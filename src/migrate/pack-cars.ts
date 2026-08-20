/**
 * Pack verified member CARs into multi-root CAR pieces.
 *
 * Uploading one piece per source CID caps throughput on per-piece overhead
 * (store round-trips, addPieces batch slots). Packing groups M source CIDs
 * into one synthetic multi-root CAR and uploads that CAR as a single piece;
 * the number of pieces (and the number of addPieces slots) drops by ~M.
 *
 * Pack stage:
 *   1. Bin-pack the free verified members largest-first under the pack
 *      target. Within each bin, members sort by parsed CID bytes (CIDv0 and
 *      CIDv1 of the same DAG collapse), which pins the multi-root CAR's
 *      bytes.
 *   2. Assemble each bin from the LOCAL member files, streaming block by
 *      block: no member CAR is ever buffered whole, so memory stays bounded
 *      regardless of piece size. The assembled piece commitment and sha256
 *      are computed from the same write stream.
 *   3. Record the piece row and its member list in one transaction, then
 *      delete the member files. A crash before the record leaves the members
 *      intact and the bin rebuilds; a crash after it leaves redundant member
 *      files the next run sweeps.
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { hasher } from '@filoz/synapse-core/piece'
import { SIZE_CONSTANTS } from '@filoz/synapse-sdk'
import { CarBlockIterator, CarWriter } from '@ipld/car'
import { CID } from 'multiformats/cid'
import type { MigrationDB, PieceRow } from './db.js'
import { log } from './util.js'

/**
 * Default target raw size for one assembled piece. 1016 MiB is the SDK's
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
 * Compare two CID strings by multihash bytes. CIDv0 (`Qm...`) and CIDv1
 * (`baf...`) of the same DAG produce wildly different lexicographic
 * orderings on the string form, and even parsed CID bytes differ (v0 is the
 * bare multihash); comparing multihashes collapses the alias so a single
 * canonical ordering exists regardless of which form the source CID was
 * registered as.
 */
export function compareCidBytes(a: string, b: string): number {
  return compareMultihashBytes(CID.parse(a), CID.parse(b))
}

/** Order two CIDs by multihash bytes; v0 and v1 of the same block compare equal. */
function compareMultihashBytes(a: CID, b: CID): number {
  const ba = a.multihash.bytes
  const bb = b.multihash.bytes
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
 * Largest-first bin pack under `targetSizeBytes` (raw bytes). Pieces above
 * the target on their own are returned in the `oversized` list so the caller
 * can ship each as a single-member bin (or refuse it past the upload cap).
 * Within each bin the members are emitted in canonical sort order.
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
 * implementation writes through to disk; tests can pass an in-memory
 * stand-in to verify the assembly without touching the filesystem.
 */
export interface WritableStreamWithLength {
  write(chunk: Uint8Array): Promise<void>
  end(): Promise<void>
}

/**
 * Build a multi-root CAR from member CAR streams, one block at a time.
 *
 * Each member is opened in canonical order, its declared roots checked
 * against the expected CID, and its blocks copied straight into the writer:
 * at no point is a whole member CAR held in memory, so a full-size piece
 * assembles in constant memory. Zero-length *sections* (the Curio indexer's
 * `ZeroLengthSectionAsEOF` truncation hazard) need no guard here: a
 * section's length always covers its CID bytes, so even an empty block is a
 * positive-length section, and `@ipld/car` rejects a true zero-length
 * section in the parser.
 */
export async function assembleMultiRootCar(
  members: Array<{ cid: string; open(): ReadableStream<Uint8Array> }>,
  sink: WritableStreamWithLength
): Promise<{ pieceCid: string; assembledBytes: number; sha256: string; roots: string[] }> {
  const roots = members.map((m) => CID.parse(m.cid))
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

  try {
    for (const member of members) {
      const expected = CID.parse(member.cid)
      const reader = await CarBlockIterator.fromIterable(toAsyncIterable(member.open()))
      const memberRoots = await reader.getRoots()
      // Multihash comparison: a member registered as CIDv0 may sit in a CAR
      // whose gateway declared the equivalent CIDv1 root.
      if (!memberRoots.some((r) => compareMultihashBytes(r, expected) === 0)) {
        throw new Error(
          `member ${member.cid}: CAR root mismatch (declares [${memberRoots.map((r) => r.toString()).join(', ')}])`
        )
      }
      for await (const block of reader) {
        // Raced against the drain loop: if the sink dies (disk full), the
        // `out` channel stops being consumed and this put would otherwise
        // park forever with the failure unobserved.
        await Promise.race([writer.put(block), drained])
      }
    }
  } catch (err) {
    // Release the writer, the drain loop, and the sink's file descriptor
    // before surfacing the member error; their own failures are secondary.
    await writer.close().catch(() => undefined)
    await drained.catch(() => undefined)
    await sink.end().catch(() => undefined)
    throw err
  }
  await writer.close()
  await drained
  await sink.end()

  return {
    pieceCid: pieceHasher.finalize().toString(),
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
 * Stream-write sink backed by a file under the staging directory. A write or
 * open failure unlinks the partial file and surfaces the original error.
 */
export function createCarStoreSink(filePath: string, onBytes?: (delta: number) => void): WritableStreamWithLength {
  const stream = createWriteStream(filePath)
  let firstError: Error | null = null
  let cleanupDone = false
  const unlinkPartial = async () => {
    if (cleanupDone) return
    cleanupDone = true
    await unlink(filePath).catch(() => undefined)
  }
  stream.on('error', (err) => {
    if (firstError == null) firstError = err
    void unlinkPartial()
  })
  return {
    write(chunk) {
      if (firstError != null) return Promise.reject(firstError)
      onBytes?.(chunk.length)
      return new Promise<void>((resolve, reject) => {
        if (firstError != null) {
          reject(firstError)
          return
        }
        const onError = (err: Error) => reject(err)
        stream.once('error', onError)
        const cleanup = () => stream.off('error', onError)
        // A buffered write resolves immediately; a flush failure lands in
        // `firstError` and fails the next write or end(). Only backpressure
        // defers (to `drain`): waiting out each flush would serialize
        // assembly on disk latency.
        const ok = stream.write(chunk, (err) => {
          if (err) {
            cleanup()
            reject(err)
          }
        })
        if (ok) {
          cleanup()
          resolve()
        } else {
          stream.once('drain', () => {
            cleanup()
            resolve()
          })
        }
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
  /** Per-piece raw-size budget. Default `DEFAULT_PACK_TARGET_BYTES`. */
  targetSizeBytes?: number
  /** Directory under which assembled CAR files are persisted. */
  carStore: string
  /** Byte-accounting hook for assembly writes (the disk-budget counter). */
  onBytesStaged?: ((delta: number) => void) | undefined
  /** Byte-accounting hook fired as each member file is deleted post-record. */
  onMemberEvicted?: ((bytes: number) => void) | undefined
}

export interface PackCarsSummary {
  bins: number
  built: number
  failed: number
  /** Source CIDs skipped because they exceed the per-piece upload cap. */
  overCap: string[]
  /**
   * Source CIDs whose bin failed to assemble. They stay `done` and re-enter
   * the free pool on the next run; a CID that keeps reappearing here has a
   * permanent assembly problem the operator must investigate. Surfaced
   * per-CID because `failed` counts bins, not CIDs.
   */
  failedMemberCids: string[]
}

/** The bin assembler `runPackCars` drives; injectable so the pack loop's
 *  success/failure accounting is testable without real member files. */
export type BinBuilder = (
  bin: PackedBin,
  carStore: string,
  memberPaths: Map<string, string>,
  onBytes?: (delta: number) => void
) => Promise<{ pieceCid: string; assembledBytes: number; sha256: string; filePath: string }>

/**
 * Drive the pack stage: bin the free verified members, assemble each bin
 * from local member files, record it, delete the member files. Idempotent:
 * re-running picks up only members not yet locked into a piece.
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

  // Snapshot the free members once. planBins partitions them into disjoint
  // bins, so this map stays valid for every bin even as each
  // recordBuiltSubPiece locks its own members.
  const free = db.donePiecesFreeForPacking()
  const piecesByCid = new Map<string, PieceRow>(free.map((p) => [p.cid, p]))
  const memberPaths = new Map<string, string>()
  for (const p of free) {
    if (p.memberCarPath != null) memberPaths.set(p.cid, p.memberCarPath)
  }
  const inputsForBuild: PackPlanInput[] = free
    .filter((p) => p.memberCarPath != null)
    .map((p) => ({ cid: p.cid, rawSize: p.rawSize ?? 0 }))
  const { bins, oversized } = planBins(inputsForBuild, target)

  // An oversized-for-bin member still ships as its own single-member piece,
  // as long as it fits one uploadable piece. Anything over the per-piece cap
  // genuinely cannot migrate on this path: mark it terminal and reclaim its
  // staged bytes, or it would sit in the free pool consuming budget forever.
  const overCap: string[] = []
  for (const p of oversized) {
    if (p.rawSize > MAX_UPLOAD_BYTES) {
      log(`! ${p.cid} (${p.rawSize} bytes) exceeds the ${MAX_UPLOAD_BYTES}-byte upload cap; not migrated`)
      overCap.push(p.cid)
      db.markOversized([p.cid])
      const memberPath = memberPaths.get(p.cid)
      if (memberPath != null) {
        const gone = await unlink(memberPath).then(
          () => true,
          () => false
        )
        if (gone) opts.onMemberEvicted?.(p.rawSize)
      }
      continue
    }
    bins.push({ memberCids: [p.cid], totalRawSize: p.rawSize })
  }

  const summary: PackCarsSummary = { bins: bins.length, built: 0, failed: 0, overCap, failedMemberCids: [] }
  for (const bin of bins) {
    // Track this bin's writes so a failed assembly returns its bytes to the
    // budget along with the unlinked partial file.
    let binWritten = 0
    // Set while a finalized CAR exists on disk without a DB row; the catch
    // unlinks it so a failed record does not strand a file whose bytes were
    // refunded to the budget.
    let builtPath: string | null = null
    const onBytes = (delta: number): void => {
      binWritten += delta
      opts.onBytesStaged?.(delta)
    }
    try {
      const built = await buildBin(bin, opts.carStore, memberPaths, onBytes)
      builtPath = built.filePath
      // The multi-root header and framing add bytes the planning weight
      // ignores; the assembled length is what the SDK caps.
      if (built.assembledBytes > MAX_UPLOAD_BYTES) {
        await unlink(built.filePath).catch(() => undefined)
        throw new Error(
          `assembled piece ${built.pieceCid} is ${built.assembledBytes} bytes, over the ${MAX_UPLOAD_BYTES}-byte cap; ` +
            `lower --pack-target-size`
        )
      }
      // One transaction inserts the piece row alongside its members. A crash
      // anywhere before this returns leaves no partial DB state: the CAR
      // file on disk is the only stranded artifact, and the next pack pass
      // rebuilds it.
      db.recordBuiltSubPiece({
        subPieceCid: built.pieceCid,
        assembledCarLength: built.assembledBytes,
        targetSizeBytes: target,
        carPath: built.filePath,
        assembledSha256: built.sha256,
        members: bin.memberCids.map((cid) => ({
          cid,
          rawSize: piecesByCid.get(cid)?.rawSize ?? null,
          sha256: piecesByCid.get(cid)?.memberSha256 ?? null,
        })),
      })
      builtPath = null
      // Members are redundant now that the recorded piece holds their bytes.
      // Budget is returned only for files actually gone; a file that resists
      // deletion keeps occupying real disk and must keep counting.
      for (const cid of bin.memberCids) {
        const memberPath = memberPaths.get(cid)
        if (memberPath != null) {
          const gone = await unlink(memberPath).then(
            () => true,
            (err: NodeJS.ErrnoException) => err.code === 'ENOENT'
          )
          if (gone) opts.onMemberEvicted?.(piecesByCid.get(cid)?.rawSize ?? 0)
        }
      }
      log(`  + piece ${built.pieceCid} (${built.assembledBytes} bytes, ${bin.memberCids.length} member(s))`)
      summary.built += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // No DB write: the members stay `done` and a transient failure recovers
      // on the next pass. A finalized CAR without a DB row is unlinked here
      // so the refund below matches what is actually on disk.
      if (builtPath != null) await unlink(builtPath).catch(() => undefined)
      if (binWritten > 0) opts.onBytesStaged?.(-binWritten)
      summary.failedMemberCids.push(...bin.memberCids)
      log(`  ! piece build failed (${bin.memberCids.length} member(s): ${bin.memberCids.join(', ')}): ${message}`)
      summary.failed += 1
    }
  }

  return summary
}

async function buildOneBin(
  bin: PackedBin,
  carStore: string,
  memberPaths: Map<string, string>,
  onBytes?: (delta: number) => void
): Promise<{ pieceCid: string; assembledBytes: number; sha256: string; filePath: string }> {
  const members = bin.memberCids.map((cid) => {
    const memberPath = memberPaths.get(cid)
    if (memberPath == null) {
      throw new Error(`member ${cid} has no staged CAR file`)
    }
    return {
      cid,
      open: () => webStreamFromFile(memberPath),
    }
  })

  const tmpName = `pack-${process.pid}-${Date.now()}.car`
  const tmpPath = path.join(carStore, tmpName)
  const sink = createCarStoreSink(tmpPath, onBytes)
  try {
    const result = await assembleMultiRootCar(members, sink)
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

function webStreamFromFile(filePath: string): ReadableStream<Uint8Array> {
  const from = (ReadableStream as unknown as { from(it: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> }).from
  return from(createReadStream(filePath) as unknown as AsyncIterable<Uint8Array>)
}
