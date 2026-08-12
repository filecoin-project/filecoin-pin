/**
 * The commP pass: CID list → piece commitments.
 *
 * Computes piece commitments for every pending source CID. Everything is
 * INSERT-only against the state DB: rerunning after adding CIDs computes only
 * the new pieces without touching prior state.
 */

import type { MigrationDB } from './db.js'
import { formatStageSummary, StageStats, Timer } from './metrics.js'
import { categoryOf, fetchAndComputePiece, type PieceResult, recordPieceOutcome } from './piece.js'
import { log, pool } from './util.js'

export interface PlanOptions {
  gateways: string[]
  concurrency: number
}

export interface PlanSummary {
  total: number
  succeeded: number
  failed: number
}

/** The piece fetcher `runPlan` drives; injectable so the plan loop is testable
 *  without a gateway. Defaults to the real {@link fetchAndComputePiece}. */
export type PieceFetcher = (cid: string, gateways: string[]) => Promise<PieceResult>

/**
 * Compute commitments for every pending CID. Idempotent: pieces already done
 * are left alone; failed pieces are retried.
 *
 * `onPieceDone` fires after each successful commitment is recorded, so a
 * streaming caller can pack and upload while later CIDs still download.
 */
export async function runPlan(
  db: MigrationDB,
  opts: PlanOptions,
  fetchPiece: PieceFetcher = fetchAndComputePiece,
  onPieceDone?: (piece: PieceResult) => Promise<void>
): Promise<PlanSummary> {
  const pending = db.pendingCids()
  log(`Computing piece commitments for ${pending.length} pending CID(s) (concurrency ${opts.concurrency})...`)

  const stats = new StageStats()
  await pool(pending, opts.concurrency, async (cid) => {
    const timer = new Timer()
    try {
      const piece = await fetchPiece(cid, opts.gateways)
      const elapsed = timer.stop()
      stats.record(piece.rawSize, elapsed)
      recordPieceOutcome(db, cid, piece)
      log(`  + ${cid} -> ${piece.pieceCid} (${piece.rawSize} bytes via ${piece.gateway}, ${Math.round(elapsed)}ms)`)
      if (onPieceDone != null) {
        await onPieceDone(piece)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      db.recordPieceFailure(cid, message, categoryOf(err))
    }
  })
  log(formatStageSummary('commP pass', stats.summary()))

  const counts = db.counts()
  return {
    total: counts.total,
    succeeded: counts.done,
    failed: counts.failed,
  }
}
