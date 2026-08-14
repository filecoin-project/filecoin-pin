/**
 * Direct upload: stream locally packed CARs straight to storage providers and
 * batch the on-chain adds. Nothing here requires inbound connectivity.
 *
 * Per built sub-piece CAR:
 *   1. store() the bytes on the primary provider: the piece is now "parked"
 *      and Curio's GC clock starts.
 *   2. Each secondary pulls the piece from the primary's retrieval URL
 *      (provider-to-provider; the client uploads once).
 *   3. Parked pieces accumulate per provider and are flushed through one
 *      commit() (addPieces) when the batch fills, the GC-window guess nears
 *      expiry, or the source drains: see gc-window.ts for the scheduling
 *      rules and why every tie breaks toward flushing early.
 *
 * Gas is the provider's cost (the provider submits addPieces with the
 * client's EIP-712 authorisation), so this loop has no base-fee gate:
 * pausing would save the provider gas while running the client's parked
 * pieces into GC.
 */

import { createReadStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { findPiece } from '@filoz/synapse-core/sp'
import type { Synapse } from '@filoz/synapse-sdk'
import { CID } from 'multiformats/cid'
import type { MigrationDB } from './db.js'
import {
  collectedCidFromError,
  DEFAULT_ASSUMED_WINDOW_MS,
  lowerWindowOnGc,
  MAX_ADD_PIECES_BATCH,
  marginFromConfirmations,
  shouldFlush,
} from './gc-window.js'
import { formatBytes, formatDuration, Timer } from './metrics.js'
import { type AddPiecesEvent, dataSetPieceId, fetchAddPiecesEvent, txLanded } from './pdp-verifier.js'
import { log } from './util.js'

export interface DirectUploadOptions {
  /** Initialized Synapse instance (auth, chain, and transport already resolved). */
  synapse: Synapse
  /** Number of provider copies (contexts). Default 2: primary + one secondary. */
  copies?: number | undefined
  /** Pin specific providers instead of SDK selection. */
  providerIds?: bigint[] | undefined
  /** Reuse existing data sets instead of creating new ones. */
  dataSetIds?: bigint[] | undefined
  /** Starting GC-window guess; persisted per-provider lowering still applies. */
  assumedWindowMs?: number | undefined
  /** Data-set metadata applied when creating or matching contexts. */
  dataSetMetadata?: Record<string, string> | undefined
  /** Route retrieval through the FilBeam egress CDN. */
  withCDN?: boolean | undefined
  /**
   * Pipeline hook: called when no sub-piece is currently pending. Resolves
   * true when new sub-pieces may have appeared (re-poll), false when the
   * source is drained. Absent means the source was fully staged up-front.
   */
  waitForMore?: (() => Promise<boolean>) | undefined
  /**
   * Pipeline hook: when it returns true while the upload queue is empty,
   * parked pieces are flushed immediately instead of waiting for a full
   * batch or the GC-window timer. The disk-budget gate uses this so blocked
   * downloads are never left waiting on a commit the batcher sees no reason
   * to hurry.
   */
  forceFlush?: (() => boolean) | undefined
}

/** The storage-context surface the loop drives; narrowed for fakes in tests. */
export interface UploadContextLike {
  providerId: string
  serviceURL: string
  dataSetId: string | null
  store(
    data: ReadableStream | Uint8Array,
    options: { pieceCid?: unknown; onProgress?: (bytes: number) => void }
  ): Promise<{ pieceCid: unknown; size: number }>
  /** EIP-712 authorization for pulls/commits of these pieces on this provider. */
  presignForCommit(pieces: Array<{ pieceCid: unknown }>): Promise<unknown>
  pull(options: {
    pieces: unknown[]
    /**
     * Pull source. MUST be the per-piece URL function form: the SDK treats a
     * string as a service-URL base and appends its own path, which mangles an
     * already-complete piece URL into a source the provider cannot fetch.
     */
    from: (pieceCid: unknown) => string
    extraData?: unknown
  }): Promise<{
    status: 'complete' | 'failed'
    pieces: Array<{ pieceCid: unknown; status: 'complete' | 'failed' }>
  }>
  commit(options: {
    pieces: Array<{ pieceCid: unknown; pieceMetadata?: Record<string, string> }>
    onSubmitted?: (txHash: string) => void
  }): Promise<{
    txHash: string
    pieceIds: bigint[]
    dataSetId: bigint
  }>
  getPieceUrl(pieceCid: unknown): string
  /** Probe whether a parked piece is still present (post-GC re-verify). */
  hasPiece(pieceCid: unknown): Promise<boolean>
}

export interface DirectUploadDeps {
  setup(opts: DirectUploadOptions): Promise<{ contexts: UploadContextLike[] }>
  /** Injectable clock so tests can drive the window timer. */
  now(): number
  /** Open a built CAR for streaming. Injectable so tests skip the filesystem. */
  openCar(path: string): ReadableStream | Uint8Array
  evictCar(path: string): Promise<void>
  /** Whether a transaction landed successfully on chain (receipt status 1). */
  txLanded(synapse: Synapse, txHash: string): Promise<boolean>
  /** Canonical on-chain witness for a landed addPieces (see pdp-verifier). */
  fetchAddPiecesEvent(synapse: Synapse, dataSetId: number, txHash: string): Promise<AddPiecesEvent | null>
  /** On-chain piece id lookup for a data set, or null when absent (see pdp-verifier). */
  dataSetPieceId(synapse: Synapse, dataSetId: number, pieceCid: string): Promise<string | null>
}

export const defaultDirectUploadDeps: DirectUploadDeps = {
  async setup(opts) {
    const contexts = await opts.synapse.storage.createContexts({
      copies: opts.copies ?? 2,
      ...(opts.providerIds == null ? {} : { providerIds: opts.providerIds }),
      ...(opts.dataSetIds == null ? {} : { dataSetIds: opts.dataSetIds }),
      // When targeting existing data sets by ID, metadata is not used for
      // matching: pass it only for creation-path selection so an existing
      // set with different metadata stays reachable.
      ...(opts.dataSetIds == null && opts.dataSetMetadata != null ? { metadata: opts.dataSetMetadata } : {}),
      ...(opts.withCDN === true ? { withCDN: true } : {}),
    })
    if (contexts.length === 0) throw new Error('no storage contexts resolved')
    return {
      contexts: contexts.map((ctx): UploadContextLike => {
        const serviceURL = ctx.provider.pdp.serviceURL
        return {
          providerId: String(ctx.provider.id),
          serviceURL,
          dataSetId: ctx.dataSetId == null ? null : String(ctx.dataSetId),
          store: (data, options) => ctx.store(data as never, options as never),
          presignForCommit: (pieces) => ctx.presignForCommit(pieces as never),
          pull: (options) => ctx.pull(options as never),
          commit: (options) => ctx.commit(options as never),
          getPieceUrl: (pieceCid) => ctx.getPieceUrl(pieceCid as never),
          hasPiece: async (pieceCid) => {
            try {
              await findPiece({ serviceURL, pieceCid: pieceCid as never, retryCount: 0 })
              return true
            } catch {
              return false
            }
          },
        }
      }),
    }
  },
  now: () => Date.now(),
  openCar: (path) => Readable.toWeb(createReadStream(path)) as ReadableStream,
  evictCar: async (path) => {
    try {
      await unlink(path)
    } catch (err) {
      // A resumed run may find the CAR already evicted by a prior run.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log(`warn: failed to evict cached CAR ${path}: ${(err as Error).message}`)
      }
    }
  },
  txLanded,
  fetchAddPiecesEvent,
  dataSetPieceId,
}

export interface DirectUploadSummary {
  network: string
  providers: Array<{
    providerId: string
    role: 'primary' | 'secondary'
    dataSetId: string | null
    committed: number
    collected: number
    failed: number
    /**
     * Pieces whose addPieces outcome is unknown (the attempt was made but
     * never confirmed either way). Anything non-zero means the run is
     * incomplete: resolve on chain before retrying.
     */
    addUnconfirmed: number
    flushes: number
    assumedWindowMs: number
    /** Distinct addPieces transaction hashes behind the committed pieces. */
    txHashes: string[]
  }>
  storedBytes: number
  evictedCars: number
}

export async function runDirectUpload(
  db: MigrationDB,
  opts: DirectUploadOptions,
  deps: DirectUploadDeps = defaultDirectUploadDeps
): Promise<DirectUploadSummary> {
  const { synapse } = opts
  const { contexts } = await deps.setup(opts)
  const [primary, ...secondaries] = contexts
  if (primary == null) throw new Error('no primary storage context')

  log(
    `direct upload to ${contexts.length} provider(s): ` +
      contexts.map((c, i) => `${i === 0 ? 'primary' : 'secondary'} ${c.providerId} (${c.serviceURL})`).join(', ')
  )

  const observedCommitMs: number[] = []
  const flushCounts = new Map<string, number>()
  const runTimer = new Timer()
  let storedBytes = 0

  const windowFor = (ctx: UploadContextLike): number =>
    db.providerWindowMs(ctx.providerId, opts.assumedWindowMs ?? DEFAULT_ASSUMED_WINDOW_MS)

  const flush = async (ctx: UploadContextLike, reason: string): Promise<void> => {
    const batch = db.parkedUploads(ctx.providerId).slice(0, MAX_ADD_PIECES_BATCH)
    if (batch.length === 0) return
    flushCounts.set(ctx.providerId, (flushCounts.get(ctx.providerId) ?? 0) + 1)
    const cids = batch.map((b) => b.subPieceCid)
    log(`flush [${reason}] provider ${ctx.providerId}: committing ${batch.length} piece(s)`)
    // Durable breadcrumb before the attempt: a crash mid-commit must never be
    // auto-resolved into a blind re-add.
    db.markUploadsAddUnconfirmed(cids, ctx.providerId)
    const commitTimer = new Timer()
    try {
      const result = await ctx.commit({
        pieces: cids.map((cid) => ({ pieceCid: CID.parse(cid) })),
        onSubmitted: (txHash) => db.markUploadTxSubmitted(cids, ctx.providerId, txHash),
      })
      observedCommitMs.push(commitTimer.stop())
      batch.forEach((b, i) => {
        db.markUploadCommitted(b.subPieceCid, ctx.providerId, {
          dataSetId: String(result.dataSetId),
          pieceId: String(result.pieceIds[i] ?? ''),
          txHash: result.txHash,
        })
      })
      log(`committed ${batch.length} piece(s) on provider ${ctx.providerId} (data set ${result.dataSetId})`)
    } catch (err) {
      const message = (err as Error).message ?? String(err)
      const gcCid = collectedCidFromError(message)
      if (gcCid == null) {
        // Not a GC rejection: leave the batch in add_unconfirmed for the
        // resume reconciliation: a blind retry could double-add on chain.
        log(`error: commit failed on provider ${ctx.providerId} (batch left add_unconfirmed): ${message}`)
        return
      }
      // Curio rejected the batch because a parked piece is gone. The batch is
      // atomic and pre-chain, so nothing landed. Lower the window from the
      // collected piece's parked age, then re-verify every batch member:
      // Curio reports only the FIRST miss.
      const collected = batch.find((b) => b.subPieceCid === gcCid)
      if (collected == null) {
        log(`warn: provider ${ctx.providerId} rejected unknown sub-piece ${gcCid}; re-verifying batch`)
      } else {
        const age = deps.now() - Date.parse(collected.parkedAt)
        const lowered = lowerWindowOnGc(windowFor(ctx), age)
        db.lowerProviderWindow(ctx.providerId, lowered)
        log(
          `GC detected on provider ${ctx.providerId}: ${gcCid} collected after ${formatDuration(age)} parked; ` +
            `window lowered to ${formatDuration(lowered)}`
        )
      }
      for (const b of batch) {
        const present = b.subPieceCid !== gcCid && (await ctx.hasPiece(CID.parse(b.subPieceCid)))
        if (present) {
          db.revertUploadsToParked([b.subPieceCid], ctx.providerId)
        } else {
          db.markUploadCollected(b.subPieceCid, ctx.providerId)
          log(`collected: ${b.subPieceCid} on provider ${ctx.providerId} (will re-store)`)
        }
      }
    }
  }

  // Evict staged CARs whose every copy is committed. Runs after every flush,
  // not just at run end: the disk high-water mark must track the uncommitted
  // window, not the whole migration. The DB keeps car_path after eviction (the
  // row is the piece's provenance), so track what this run already unlinked.
  const evictedPaths = new Set<string>()
  const evictCommitted = async (): Promise<void> => {
    for (const path of db.carPathsEvictable()) {
      if (evictedPaths.has(path)) continue
      await deps.evictCar(path)
      evictedPaths.add(path)
    }
  }

  const maybeFlush = async (drained: boolean): Promise<void> => {
    for (const ctx of contexts) {
      // Loop: a full batch may leave more parked pieces behind it.
      for (;;) {
        const parked = db.parkedUploads(ctx.providerId)
        const oldest = parked[0]
        const reason = shouldFlush({
          batchSize: parked.length,
          oldestParkedAtMs: oldest == null ? null : Date.parse(oldest.parkedAt),
          nowMs: deps.now(),
          assumedWindowMs: windowFor(ctx),
          marginMs: marginFromConfirmations(observedCommitMs),
          drained,
        })
        if (reason == null) break
        await flush(ctx, reason)
        if (db.parkedUploads(ctx.providerId).length === parked.length) break // no progress; avoid spinning
      }
    }
    await evictCommitted()
  }

  // Reconcile add_unconfirmed leftovers from a previous run before uploading
  // anything new: their outcome is unknown and a blind re-add would duplicate.
  for (const ctx of contexts) {
    await reconcileUnconfirmed(db, synapse, ctx, deps)
  }

  // Main loop: store on the primary, fan out to secondaries, flush as batches
  // and window timers demand. Sequential per piece: the upstream bandwidth is
  // the bottleneck, and one in-flight store keeps the disk footprint bounded.
  // In the pipeline an empty pending list means "wait for the packer", not
  // "done": `waitForMore` resolves false only when the source is drained.
  // A piece the provider disagreed with (commP mismatch) is recorded as a
  // failed upload and drops out of this query, so it cannot re-store in a
  // loop.
  for (;;) {
    const pending = db.subPiecesNeedingUpload(primary.providerId)
    const next = pending[0]
    if (next == null) {
      if (opts.forceFlush?.() === true) {
        // Downloads are blocked on the disk budget; commit whatever is
        // parked now so eviction can free space, rather than holding the
        // batch for the GC-window timer.
        await maybeFlush(true)
      }
      if (opts.waitForMore != null && (await opts.waitForMore())) {
        continue
      }
      break
    }
    if (next.carPath == null) {
      // subPiecesNeedingUpload selects built rows, which always carry a CAR
      // path; reaching this is a query bug.
      throw new Error(`sub-piece ${next.subPieceCid} has no local CAR path`)
    }

    const storeTimer = new Timer()
    let stored: { size: number }
    try {
      stored = await storeCar(primary, deps, next.carPath, next.subPieceCid)
    } catch (err) {
      if (err instanceof CommPMismatchError) {
        db.markUploadFailed(next.subPieceCid, primary.providerId, 'primary', err.message)
        log(`error: ${err.message}`)
        continue
      }
      throw err
    }
    storedBytes += stored.size
    db.recordUploadParked(next.subPieceCid, primary.providerId, 'primary', primary.dataSetId)
    log(
      `parked ${next.subPieceCid} (${formatBytes(stored.size)}) on primary ${primary.providerId} ` +
        `in ${formatDuration(storeTimer.stop())}`
    )

    // Check the flush timers before the secondary fanout as well as after: a
    // slow provider-to-provider pull must not age already-parked pieces past
    // the GC window.
    await maybeFlush(false)
    for (const secondary of secondaries) {
      await pullToSecondary(db, primary, secondary, next.subPieceCid)
    }

    await maybeFlush(false)
  }

  // Source drained. Flush whatever is parked, then retry what didn't land:
  // collected pieces (GC'd before commit) and failed secondary pulls. A
  // primary copy re-uploads from the staged CAR; a secondary copy re-pulls
  // from the primary, which still holds the bytes.
  await maybeFlush(true)
  for (let attempt = 0; attempt < 3; attempt++) {
    // A crash between the primary store and the secondary pull leaves a
    // sub-piece with a live primary row and no row at all for the secondary;
    // repair those alongside the recorded retry states, or the secondary
    // copy would silently never exist.
    const missingSecondaries = secondaries.flatMap((ctx) =>
      db.subPiecesMissingSecondary(primary.providerId, ctx.providerId).map((subPieceCid) => ({ ctx, subPieceCid }))
    )
    const needsRetry = contexts.flatMap((ctx, i) =>
      ['collected' as const, ...(i > 0 ? ['failed' as const] : [])]
        .flatMap((status) => db.uploadsByStatus(ctx.providerId, status))
        .map((u) => ({ ctx, u }))
    )
    if (needsRetry.length === 0 && missingSecondaries.length === 0) break
    log(`retrying ${needsRetry.length + missingSecondaries.length} piece(s) that did not land (attempt ${attempt + 1})`)
    for (const { ctx, subPieceCid } of missingSecondaries) {
      await pullToSecondary(db, primary, ctx, subPieceCid)
    }
    for (const { ctx, u } of needsRetry) {
      if (u.role === 'secondary') {
        await pullToSecondary(db, primary, ctx, u.subPieceCid)
        continue
      }
      const sub = db.subPieceByCid(u.subPieceCid)
      if (sub?.carPath == null) {
        log(`error: collected ${u.subPieceCid} has no local CAR; cannot re-store`)
        continue
      }
      try {
        const stored = await storeCar(ctx, deps, sub.carPath, sub.subPieceCid)
        storedBytes += stored.size
        db.recordUploadParked(sub.subPieceCid, ctx.providerId, u.role, ctx.dataSetId)
      } catch (err) {
        if (err instanceof CommPMismatchError) {
          db.markUploadFailed(sub.subPieceCid, ctx.providerId, u.role, err.message)
          log(`error: ${err.message}`)
          continue
        }
        throw err
      }
    }
    await maybeFlush(true)
  }

  await evictCommitted()

  const summary: DirectUploadSummary = {
    network: synapse.chain.name,
    providers: contexts.map((ctx, i) => {
      const committed = db.uploadsByStatus(ctx.providerId, 'committed')
      return {
        providerId: ctx.providerId,
        role: i === 0 ? ('primary' as const) : ('secondary' as const),
        dataSetId: latestDataSetId(db, ctx),
        committed: committed.length,
        collected: db.uploadsByStatus(ctx.providerId, 'collected').length,
        failed: db.uploadsByStatus(ctx.providerId, 'failed').length,
        addUnconfirmed: db.uploadsByStatus(ctx.providerId, 'add_unconfirmed').length,
        flushes: flushCounts.get(ctx.providerId) ?? 0,
        assumedWindowMs: windowFor(ctx),
        txHashes: [...new Set(committed.map((u) => u.txHash).filter((h): h is string => h != null))],
      }
    }),
    storedBytes,
    evictedCars: evictedPaths.size,
  }
  log(`direct upload finished in ${formatDuration(runTimer.stop())}: ${formatBytes(storedBytes)} stored`)
  return summary
}

/**
 * How old a hashless add_unconfirmed breadcrumb must be before an
 * absent-on-chain verdict is trusted enough to re-queue the piece. Sized to
 * outlast any realistic transaction confirmation window.
 */
export const HASHLESS_REQUEUE_AFTER_MS = 60 * 60_000

/** Thrown when the provider's commitment over the uploaded bytes disagrees with ours. */
export class CommPMismatchError extends Error {
  constructor(subPieceCid: string, providerId: string, got: string) {
    super(`commP mismatch on provider ${providerId}: expected ${subPieceCid}, provider computed ${got}`)
    this.name = 'CommPMismatchError'
  }
}

async function storeCar(
  ctx: UploadContextLike,
  deps: DirectUploadDeps,
  carPath: string,
  subPieceCid: string
): Promise<{ size: number }> {
  const result = await ctx.store(deps.openCar(carPath), { pieceCid: CID.parse(subPieceCid) })
  // The committed CID must be the commitment over the bytes the provider
  // actually holds; trusting the SDK to throw on divergence is not enough.
  const got = String(result.pieceCid)
  if (got !== subPieceCid) {
    throw new CommPMismatchError(subPieceCid, ctx.providerId, got)
  }
  return { size: result.size }
}

/**
 * Resolve every add_unconfirmed row. The transaction receipt is checked first:
 * piece presence alone cannot distinguish "commit never landed" from "commit
 * landed but confirmation was missed": the provider keeps the bytes either
 * way, and re-queueing a landed commit would add the piece twice.
 */
async function reconcileUnconfirmed(
  db: MigrationDB,
  synapse: Synapse,
  ctx: UploadContextLike,
  deps: DirectUploadDeps
): Promise<void> {
  for (const u of db.uploadsByStatus(ctx.providerId, 'add_unconfirmed')) {
    if (u.txHash == null) {
      // The crash landed between the transaction broadcast and the hash
      // callback, so no receipt can be checked. The data set itself is the
      // witness: a piece present on chain is committed; an absent one did
      // not land. Without a known data set neither can be told apart, so the
      // row stays unresolved and the run exits incomplete.
      const dataSetId = u.dataSetId ?? ctx.dataSetId
      if (dataSetId == null) {
        log(
          `resume: ${u.subPieceCid} has an unconfirmed addPieces with no transaction hash and no known data set ` +
            `on provider ${ctx.providerId}; left add_unconfirmed for manual resolution`
        )
        continue
      }
      const pieceId = await deps.dataSetPieceId(synapse, Number(dataSetId), u.subPieceCid)
      if (pieceId != null) {
        db.markUploadCommitted(u.subPieceCid, ctx.providerId, { dataSetId, pieceId, txHash: null })
        log(`resume: ${u.subPieceCid} found on chain in data set ${dataSetId} (piece ${pieceId}); marked committed`)
        continue
      }
      // Absent on chain. A transaction the provider broadcast just before
      // the crash could still land, and re-queueing while it can would add
      // the piece twice, so the row only re-enters the flow once the
      // breadcrumb is older than any realistic confirmation window. Younger
      // rows stay unresolved and the run exits incomplete; a re-run later
      // resolves them one way or the other.
      const ageMs = deps.now() - Date.parse(u.updatedAt)
      if (ageMs < HASHLESS_REQUEUE_AFTER_MS) {
        log(
          `resume: ${u.subPieceCid} has an unconfirmed addPieces with no transaction hash and is absent from ` +
            `data set ${dataSetId}; too recent to rule out an in-flight transaction, left add_unconfirmed ` +
            `(re-run after ${formatDuration(HASHLESS_REQUEUE_AFTER_MS - ageMs)})`
        )
        continue
      }
      // Old enough that an in-flight transaction would have landed or died.
      // Fall through to the presence check below so the piece re-parks or
      // re-stores like any other unconfirmed attempt.
    }
    if (u.txHash != null && (await deps.txLanded(synapse, u.txHash))) {
      // The commit landed; only local confirmation was missed. Resolve it from
      // the canonical witness (the PiecesAdded event) rather than trusting
      // any side channel. The row's own data set takes precedence: a resumed
      // run may have opened a different context than the one that committed.
      const dataSetId = u.dataSetId ?? ctx.dataSetId
      if (dataSetId != null) {
        const event = await deps.fetchAddPiecesEvent(synapse, Number(dataSetId), u.txHash)
        const pieceIndex = event == null ? -1 : event.pieceCids.indexOf(u.subPieceCid)
        if (event != null && pieceIndex >= 0) {
          db.markUploadCommitted(u.subPieceCid, ctx.providerId, {
            dataSetId,
            pieceId: String(event.pieceIds[pieceIndex] ?? ''),
            txHash: u.txHash,
          })
          log(
            `resume: ${u.subPieceCid} confirmed on chain via PiecesAdded (tx ${u.txHash}, ` +
              `data set ${dataSetId}); marked committed`
          )
          continue
        }
      }
      log(
        `resume: ${u.subPieceCid} has a LANDED addPieces tx ${u.txHash} on provider ${ctx.providerId} ` +
          `but its PiecesAdded event could not be verified; leaving add_unconfirmed: check the data set ` +
          `on the explorer before any manual retry (a blind re-add would duplicate the piece)`
      )
      continue
    }
    if (await ctx.hasPiece(CID.parse(u.subPieceCid))) {
      db.revertUploadsToParked([u.subPieceCid], ctx.providerId)
      log(`resume: ${u.subPieceCid} still parked on provider ${ctx.providerId}; re-queued for commit`)
    } else {
      db.markUploadCollected(u.subPieceCid, ctx.providerId)
      log(`resume: ${u.subPieceCid} gone from provider ${ctx.providerId}; will re-store`)
    }
  }
}

/** Have one secondary pull a freshly parked piece from the primary. */
async function pullToSecondary(
  db: MigrationDB,
  primary: UploadContextLike,
  secondary: UploadContextLike,
  subPieceCid: string
): Promise<void> {
  try {
    // Curio authenticates the pull with the same EIP-712 authorization used
    // for commit: a pull without it is rejected.
    const extraData = await secondary.presignForCommit([{ pieceCid: CID.parse(subPieceCid) }])
    const pulled = await secondary.pull({
      pieces: [CID.parse(subPieceCid)],
      from: (pieceCid) => primary.getPieceUrl(pieceCid),
      extraData,
    })
    if (pulled.status === 'complete') {
      db.recordUploadParked(subPieceCid, secondary.providerId, 'secondary', secondary.dataSetId)
      log(`parked ${subPieceCid} on secondary ${secondary.providerId} (pulled from primary)`)
    } else {
      db.markUploadFailed(subPieceCid, secondary.providerId, 'secondary', 'secondary pull failed')
      log(`warn: secondary ${secondary.providerId} failed to pull ${subPieceCid}`)
    }
  } catch (err) {
    db.markUploadFailed(subPieceCid, secondary.providerId, 'secondary', (err as Error).message)
    log(`warn: secondary ${secondary.providerId} pull error for ${subPieceCid}: ${(err as Error).message}`)
  }
}

function latestDataSetId(db: MigrationDB, ctx: UploadContextLike): string | null {
  const committed = db.uploadsByStatus(ctx.providerId, 'committed')
  const last = committed[committed.length - 1]
  return last != null ? last.dataSetId : ctx.dataSetId
}
