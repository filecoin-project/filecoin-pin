/**
 * Top-level migrate orchestration: one pipeline, clocked by a disk budget.
 *
 *   download + verify --> pack --> upload --> commit --> evict
 *           ^                                              |
 *           +-------------- disk budget freed <------------+
 *
 * Download workers stage verified member CARs on disk; the packer assembles
 * them into multi-root pieces; the uploader stores, batch-commits, and evicts
 * them. Everything staged counts against one byte budget, and a download may
 * only start while the budget has headroom for a pack assembly on top of it,
 * so the pipeline runs at the speed of its slowest stage with a hard bound on
 * disk. There is no rate measurement anywhere: a bounded pipeline finds the
 * bottleneck rate by itself and keeps adapting as conditions change.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Synapse } from '@filoz/synapse-sdk'
import type { MigrationDB } from './db.js'
import {
  type DirectUploadDeps,
  type DirectUploadOptions,
  type DirectUploadSummary,
  defaultDirectUploadDeps,
  runDirectUpload,
} from './direct-upload.js'
import { formatBytes } from './metrics.js'
import { type BinBuilder, runPackCars } from './pack-cars.js'
import { log } from './util.js'
import { categoryOf, type StagedMember, stageMember, VerifyCarError, type VerifyCarOptions } from './verify-car.js'

export interface MigrateRunOptions {
  synapse: Synapse
  gateways: string[]
  /** Directory for verified member CAR files. */
  memberDir: string
  /** Directory for assembled piece CAR files. */
  carStore: string
  /** Per-piece raw-size budget for packing. */
  packTargetBytes: number
  /** Download concurrency. */
  concurrency: number
  /** Staging byte budget; must be at least 2x the pack target. */
  budgetBytes: number
  copies?: number | undefined
  providerIds?: bigint[] | undefined
  dataSetIds?: bigint[] | undefined
  assumedWindowMs?: number | undefined
  dataSetMetadata?: Record<string, string> | undefined
  withCDN?: boolean | undefined
  /** Test seam: replaces the gateway member stager. */
  stageMemberFn?: typeof stageMember | undefined
  /** Test seam: replaces the per-bin CAR assembler. */
  buildBin?: BinBuilder | undefined
}

export interface MigrateSummary extends DirectUploadSummary {
  /** Download outcome over the registered source CIDs. */
  pieces: { total: number; succeeded: number; failed: number; pending: number }
  /** Source CIDs skipped because they exceed the per-piece upload cap. */
  overCap: string[]
}

/** Raised into parked download workers when nothing can ever free the budget. */
class PipelineStuckError extends Error {
  constructor() {
    super(
      'staging budget is full and the remaining staged pieces have unresolved or failed commits; ' +
        'resolve them on chain (see the summary) and re-run'
    )
    this.name = 'PipelineStuckError'
  }
}

/**
 * The staged-byte counter and its wait queue. Downloads gate on
 * `waitToStart`; eviction and member deletion call `free`, which wakes
 * waiters. The assembly reservation is implicit in the thresholds: new
 * downloads need `2x packTarget` of headroom and running downloads abort at
 * `total - packTarget`, so one pack assembly always fits under `total`.
 */
class StagingBudget {
  used = 0
  #waiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = []
  #failedWith: Error | null = null
  constructor(
    readonly total: number,
    readonly packTarget: number
  ) {}

  get startGate(): number {
    return this.total - 2 * this.packTarget
  }

  get hardCap(): number {
    return this.total - this.packTarget
  }

  add(delta: number): void {
    this.used += delta
  }

  free(delta: number): void {
    this.used -= delta
    if (this.used < 0) this.used = 0
    this.wakeAll()
  }

  wakeAll(): void {
    const waiters = this.#waiters
    this.#waiters = []
    for (const w of waiters) w.resolve()
  }

  failAll(err: Error): void {
    this.#failedWith = err
    const waiters = this.#waiters
    this.#waiters = []
    for (const w of waiters) w.reject(err)
  }

  get waiting(): number {
    return this.#waiters.length
  }

  async waitToStart(onParked: () => void): Promise<void> {
    while (this.used > this.startGate) {
      // A budget already declared dead must reject late arrivals too, or a
      // worker parking after failAll would wait forever.
      if (this.#failedWith != null) throw this.#failedWith
      await new Promise<void>((resolve, reject) => {
        this.#waiters.push({ resolve, reject })
        onParked()
      })
    }
    if (this.#failedWith != null) throw this.#failedWith
  }
}

/**
 * Reconcile the staging directories with the DB before any new work:
 * leftover temp files and unreferenced files are deleted, `done` pieces
 * whose member file is missing or truncated go back to `pending`, and the
 * budget counter starts from what is actually still on disk.
 */
async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Uint8Array)
  }
  return hash.digest('hex')
}

async function sweepStaging(db: MigrationDB, memberDir: string, carStore: string): Promise<number> {
  let staged = 0
  const referenced = new Set<string>()

  for (const piece of db.donePiecesWithMembers()) {
    referenced.add(piece.memberCarPath)
    const fileStat = await stat(piece.memberCarPath).catch(() => null)
    if (fileStat == null || !fileStat.isFile()) {
      log(`sweep: member file for ${piece.cid} is missing; re-queueing the download`)
      db.resetPieceToPending(piece.cid)
      continue
    }
    // A member is trusted only if its bytes still hash to what the verified
    // download recorded; silent disk corruption would otherwise flow into a
    // packed piece. Pieces already locked into a recorded piece are not
    // re-read: their bytes live in the piece CAR, whose commitment the
    // provider re-checks at store time.
    if (piece.memberSha256 != null) {
      const actual = await sha256File(piece.memberCarPath).catch(() => null)
      if (actual !== piece.memberSha256) {
        log(`sweep: member file for ${piece.cid} does not match its recorded hash; re-queueing the download`)
        await unlink(piece.memberCarPath).catch(() => undefined)
        db.resetPieceToPending(piece.cid)
      }
    }
  }
  // Free members count against the budget; members already locked into a
  // recorded piece are redundant leftovers and are deleted below.
  staged += db.freeMemberBytes()

  const evictable = new Set(db.carPathsEvictable())
  for (const sub of db.subPiecesByStatus('built')) {
    if (sub.carPath == null) continue
    referenced.add(sub.carPath)
    const fileStat = await stat(sub.carPath).catch(() => null)
    if (fileStat == null) {
      if (!evictable.has(sub.carPath)) {
        log(`sweep: staged piece ${sub.subPieceCid} is missing its CAR file; its upload cannot be retried locally`)
      }
      continue
    }
    if (evictable.has(sub.carPath)) {
      // Committed in a previous run but never unlinked.
      await unlink(sub.carPath).catch(() => undefined)
      continue
    }
    staged += sub.assembledCarLength
  }

  // Anything on disk the DB does not reference is an orphan: interrupted
  // temp files, members from a crash after their pack record, pieces evicted
  // from the DB's point of view but never unlinked.
  for (const dir of [memberDir, carStore]) {
    const entries = await readdir(dir).catch(() => [] as string[])
    for (const entry of entries) {
      const entryPath = join(dir, entry)
      if (referenced.has(entryPath)) continue
      await unlink(entryPath).catch(() => undefined)
    }
  }

  return staged
}

/** Run the full migrate flow over the CIDs already registered in `db`. */
export async function runMigrate(
  db: MigrationDB,
  opts: MigrateRunOptions,
  deps: DirectUploadDeps = defaultDirectUploadDeps
): Promise<MigrateSummary> {
  if (opts.budgetBytes < 2 * opts.packTargetBytes) {
    throw new Error(
      `staging budget ${formatBytes(opts.budgetBytes)} is too small to assemble one ` +
        `${formatBytes(opts.packTargetBytes)} piece; free disk space or lower --pack-target-size`
    )
  }
  const stage = opts.stageMemberFn ?? stageMember

  // Resolve the storage contexts once; the upload loop reuses them (and a
  // test fake sees a single setup call).
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
  const primaryProviderId = contexts[0]?.providerId

  const budget = new StagingBudget(opts.budgetBytes, opts.packTargetBytes)
  budget.used = await sweepStaging(db, opts.memberDir, opts.carStore)
  log(`staging budget ${formatBytes(budget.total)} (${formatBytes(budget.used)} already staged from a previous run)`)

  // Track each built piece's size so eviction can return its bytes.
  const binBytes = new Map<string, number>()
  for (const sub of db.subPiecesByStatus('built')) {
    if (sub.carPath != null) binBytes.set(sub.carPath, sub.assembledCarLength)
  }

  const overCap: string[] = []

  // The uploader parks here between pieces; wake it when the packer builds
  // something and drain it when the producer finishes.
  let drained = false
  let uploaderParked = false
  let wakeUploader: Array<() => void> = []
  const notifyUploader = (): void => {
    const waiters = wakeUploader
    wakeUploader = []
    uploaderParked = false
    for (const wake of waiters) wake()
  }
  const waitForMore = async (): Promise<boolean> => {
    if (drained) return false
    await new Promise<void>((resolve) => {
      uploaderParked = true
      wakeUploader.push(resolve)
      checkStuck()
    })
    return true
  }

  // Progress guard, evaluated whenever both sides are parked (downloads on
  // the budget, the uploader on an empty queue). In order of preference:
  // wake the uploader (something is uploadable or flushable), pack a partial
  // bin (members exist but below the pack target), or, when everything
  // staged is stuck in unresolved commits, stop the producers so the run
  // finishes incomplete and resumable instead of hanging.
  let stuck = false
  let inFlightDownloads = 0
  const checkStuck = (): void => {
    if (stuck || primaryProviderId == null) return
    if (!uploaderParked || budget.waiting === 0) return
    if (
      db.subPiecesNeedingUpload(primaryProviderId).length > 0 ||
      db.parkedUploads(primaryProviderId).length > 0 ||
      db.uploadsByStatus(primaryProviderId, 'collected').length > 0
    ) {
      notifyUploader()
      return
    }
    if (db.freeMemberBytes() > 0) {
      void packNow()
      return
    }
    // A download still in flight will stage a member and re-evaluate when it
    // lands; only a fully quiet pipeline is actually stuck.
    if (inFlightDownloads > 0) return
    stuck = true
    budget.failAll(new PipelineStuckError())
  }

  // One pack at a time: triggers fire from concurrent download workers, and
  // two overlapping runPackCars calls would race the same free members.
  // Failures are captured rather than left on the chain so an unobserved
  // rejection cannot take the process down.
  let packChain: Promise<void> = Promise.resolve()
  let packError: unknown = null
  const packNow = (): Promise<void> => {
    packChain = packChain
      .then(async () => {
        const packed = await runPackCars(
          db,
          {
            targetSizeBytes: opts.packTargetBytes,
            carStore: opts.carStore,
            onBytesStaged: (delta) => budget.add(delta),
            onMemberEvicted: (bytes) => budget.free(bytes),
          },
          opts.buildBin
        )
        overCap.push(...packed.overCap)
        if (packed.built > 0) {
          for (const sub of db.subPiecesByStatus('built')) {
            if (sub.carPath != null && !binBytes.has(sub.carPath)) binBytes.set(sub.carPath, sub.assembledCarLength)
          }
          notifyUploader()
        }
      })
      .catch((err) => {
        if (packError == null) packError = err
      })
    return packChain
  }

  const producer = (async () => {
    try {
      const pending = db.pendingCids()
      log(`downloading ${pending.length} CID(s) (concurrency ${opts.concurrency}, budget-gated)...`)
      let cursor = 0
      const worker = async (): Promise<void> => {
        while (cursor < pending.length) {
          const cid = pending[cursor++]
          if (cid == null) continue
          // Retry the same CID until it stages, fails terminally, or the
          // pipeline is declared stuck.
          for (;;) {
            try {
              await budget.waitToStart(checkStuck)
            } catch (err) {
              if (err instanceof PipelineStuckError) return
              throw err
            }
            let written = 0
            const verifyOpts: VerifyCarOptions = {
              onBytes: (delta) => {
                budget.add(delta)
                written += delta
                if (budget.used > budget.hardCap) {
                  throw new VerifyCarError(
                    `staging budget exhausted while downloading ${cid}; retrying once space frees`,
                    'staging_budget'
                  )
                }
              },
            }
            let member: StagedMember
            inFlightDownloads++
            try {
              member = await stage(cid, opts.gateways, opts.memberDir, verifyOpts)
            } catch (err) {
              // The temp file is gone either way; return its bytes.
              budget.free(written)
              if (categoryOf(err) === 'staging_budget') {
                continue
              }
              const message = err instanceof Error ? err.message : String(err)
              db.recordPieceFailure(cid, message, categoryOf(err))
              break
            } finally {
              inFlightDownloads--
            }
            db.recordPieceSuccess(cid, member)
            if (db.freeMemberBytes() >= opts.packTargetBytes) {
              // Kick the packer without awaiting it: parking a download
              // worker behind an assembly would serialize the stages this
              // pipeline exists to overlap. The chained promise is awaited
              // at drain, so a pack failure still surfaces.
              void packNow()
            } else {
              // Below the pack threshold. If everyone else is already
              // parked, this member is the only thing that can move the
              // pipeline; re-evaluate so a partial bin ships instead of the
              // run stalling.
              checkStuck()
            }
            break
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(opts.concurrency, pending.length) }, () => worker()))
      // The remainder below one pack target still ships, in smaller bins.
      await packNow()
      if (packError != null) throw packError
    } finally {
      drained = true
      notifyUploader()
    }
  })()

  // Eviction returns a piece's bytes to the budget, which unblocks parked
  // download workers.
  const evictingDeps: DirectUploadDeps = {
    ...cachedDeps,
    evictCar: async (path) => {
      await cachedDeps.evictCar(path)
      budget.free(binBytes.get(path) ?? 0)
    },
  }

  const consumer = runDirectUpload(
    db,
    { ...uploadOptions, waitForMore, forceFlush: () => budget.waiting > 0 },
    evictingDeps
  )

  // Surface whichever side failed; a producer failure still drains the
  // consumer (the finally above), so both settle.
  const [, uploadSummary] = await Promise.all([producer, consumer])

  if (stuck) {
    log('warn: run stopped early: staging budget full with unresolved commits; the summary lists them')
  }

  const counts = db.counts()
  return {
    ...uploadSummary,
    pieces: { total: counts.total, succeeded: counts.done, failed: counts.failed, pending: counts.pending },
    overCap,
  }
}
