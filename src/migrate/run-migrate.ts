/**
 * Top-level migrate orchestration: CID list → commP pass → packed CARs →
 * direct upload → manifest.
 *
 * Two modes:
 *
 *   streaming (default)  pack and store pieces as CIDs finish downloading;
 *                        the commit batcher flushes when a batch fills or the
 *                        GC margin nears. The uploader runs concurrently with
 *                        the commP pass, so wall-clock tracks the slower of
 *                        download and upload bandwidth instead of their sum.
 *   staged               pack everything first, then upload: ipfs2foc's
 *                        original behavior. Uses more staging disk (the whole
 *                        migration is on disk at the high-water mark).
 */

import type { Synapse } from '@filoz/synapse-sdk'
import type { MigrationDB } from './db.js'
import {
  type DirectUploadDeps,
  type DirectUploadOptions,
  type DirectUploadSummary,
  defaultDirectUploadDeps,
  runDirectUpload,
} from './direct-upload.js'
import { buildManifest, type ManifestUploadResult, uploadManifest } from './manifest.js'
import { type BinBuilder, runPackCars } from './pack-cars.js'
import { type PieceFetcher, runPlan } from './plan.js'
import { log } from './util.js'

export type MigrateMode = 'streaming' | 'staged'

export interface MigrateRunOptions {
  synapse: Synapse
  gateways: string[]
  /** Staging directory for packed CAR files. */
  carStore: string
  mode: MigrateMode
  /** Per-sub-piece raw-size budget for packing. */
  packTargetBytes: number
  /** commP-pass download concurrency. */
  concurrency: number
  copies?: number | undefined
  providerIds?: bigint[] | undefined
  dataSetIds?: bigint[] | undefined
  assumedWindowMs?: number | undefined
  dataSetMetadata?: Record<string, string> | undefined
  withCDN?: boolean | undefined
  /** Write and upload the migration manifest (default true). */
  manifest: boolean
  /** Test seam: replaces the gateway piece fetcher for the commP pass. */
  fetchPiece?: PieceFetcher | undefined
  /** Test seam: replaces the per-bin CAR assembler for the pack stage. */
  buildBin?: BinBuilder | undefined
}

export interface MigrateSummary extends DirectUploadSummary {
  /** commP-pass outcome over the registered source CIDs. */
  pieces: { total: number; succeeded: number; failed: number }
  /** Source CIDs skipped because they exceed the per-piece upload cap. */
  overCap: string[]
  manifest: ManifestUploadResult | null
}

/** Run the full migrate flow over the CIDs already registered in `db`. */
export async function runMigrate(
  db: MigrationDB,
  opts: MigrateRunOptions,
  deps: DirectUploadDeps = defaultDirectUploadDeps
): Promise<MigrateSummary> {
  const startedAt = new Date().toISOString()

  // Resolve the storage contexts once; the upload loop and the manifest
  // upload share them (and a test fake sees a single setup call).
  const uploadOptions: DirectUploadOptions = {
    synapse: opts.synapse,
    copies: opts.copies,
    providerIds: opts.providerIds,
    dataSetIds: opts.dataSetIds,
    assumedWindowMs: opts.assumedWindowMs,
    dataSetMetadata: opts.dataSetMetadata,
    withCDN: opts.withCDN,
  }
  const { contexts } = await deps.setup(uploadOptions)
  const cachedDeps: DirectUploadDeps = { ...deps, setup: async () => ({ contexts }) }

  const overCap: string[] = []
  const packOptions = {
    gateways: opts.gateways,
    targetSizeBytes: opts.packTargetBytes,
    carStore: opts.carStore,
  }

  let uploadSummary: DirectUploadSummary
  if (opts.mode === 'staged') {
    await runPlan(db, { gateways: opts.gateways, concurrency: opts.concurrency }, opts.fetchPiece)
    const packed = await runPackCars(db, packOptions, opts.buildBin)
    overCap.push(...packed.overCap)
    log(`packed ${packed.built} multi-root CAR(s) under ${opts.carStore}`)
    uploadSummary = await runDirectUpload(db, uploadOptions, cachedDeps)
  } else {
    // Streaming: the commP pass runs as the producer; whenever enough free
    // bytes accumulate it packs a batch of CARs and wakes the uploader. The
    // uploader consumes sub-pieces as they appear and parks in `waitForMore`
    // when it catches up.
    let drained = false
    let wakeQueue: Array<() => void> = []
    const notify = (): void => {
      const waiters = wakeQueue
      wakeQueue = []
      for (const wake of waiters) wake()
    }
    const waitForMore = async (): Promise<boolean> => {
      if (drained) return false
      await new Promise<void>((resolve) => {
        wakeQueue.push(resolve)
      })
      return true
    }

    // One pack at a time: onPieceDone fires from concurrent download workers,
    // and two overlapping runPackCars calls would race the same free pieces.
    // Failures are captured rather than left on the chain: a rejection with
    // no handler until the drain would take the process down as an unhandled
    // rejection.
    let packChain: Promise<void> = Promise.resolve()
    let packError: unknown = null
    const packNow = (): Promise<void> => {
      packChain = packChain
        .then(async () => {
          const packed = await runPackCars(db, packOptions, opts.buildBin)
          overCap.push(...packed.overCap)
          if (packed.built > 0) notify()
        })
        .catch((err) => {
          if (packError == null) packError = err
        })
      return packChain
    }

    const freeBytes = (): number => db.donePiecesFreeForPacking().reduce((sum, p) => sum + (p.rawSize ?? 0), 0)

    const producer = (async () => {
      try {
        await runPlan(db, { gateways: opts.gateways, concurrency: opts.concurrency }, opts.fetchPiece, async () => {
          // Kick the packer without awaiting it: packing re-downloads member
          // CARs, and parking a download worker behind that would serialize
          // the two stages this mode exists to overlap. The chained promise
          // is awaited below, so a pack failure still surfaces.
          if (freeBytes() >= opts.packTargetBytes) {
            void packNow()
          }
        })
        // Remainder below one pack target still ships, in smaller bins.
        await packNow()
        if (packError != null) throw packError
      } finally {
        drained = true
        notify()
      }
    })()

    const consumer = runDirectUpload(db, { ...uploadOptions, waitForMore }, cachedDeps)

    // Surface whichever side failed; a producer failure still drains the
    // consumer (the finally above), so both settle.
    const [, summary] = await Promise.all([producer, consumer])
    uploadSummary = summary
  }

  let manifestResult: ManifestUploadResult | null = null
  if (opts.manifest) {
    const manifest = buildManifest(db, uploadSummary, startedAt)
    manifestResult = await uploadManifest(manifest, contexts, cachedDeps)
  }

  const counts = db.counts()
  return {
    ...uploadSummary,
    pieces: { total: counts.total, succeeded: counts.done, failed: counts.failed },
    overCap,
    manifest: manifestResult,
  }
}
