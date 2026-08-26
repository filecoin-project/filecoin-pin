/**
 * Flush scheduling and GC-window estimation for the migrate direct-upload
 * flow.
 *
 * Curio garbage-collects parked pieces that have not been added on chain.
 * The window is roughly 2h, SP-configurable, and not discoverable, so the
 * client flushes before its own best guess expires. The guess starts
 * conservative and only ever moves down: a successful run proves you stayed
 * under the window, not that the window is longer, while a detected GC proves
 * the window is at most the collected piece's parked age.
 *
 * The costs are asymmetric: an early flush costs one extra transaction, a
 * collected piece costs a full re-upload of up to MAX_UPLOAD_SIZE bytes, so
 * every rounding here rounds toward flushing sooner.
 *
 * Everything in this module is pure; the orchestrator in direct-upload.ts
 * owns the clock and the DB.
 */

import { SIZE_CONSTANTS } from '@filoz/synapse-sdk'

/** FWSS `addPieces` batch cap, from the SDK. */
export const MAX_ADD_PIECES_BATCH = SIZE_CONSTANTS.MAX_ADD_PIECES_BATCH_SIZE

/**
 * Starting guess for a provider's GC window. Half of Curio's ~2h default:
 * under-guessing costs early flushes, over-guessing costs re-uploads.
 */
export const DEFAULT_ASSUMED_WINDOW_MS = 60 * 60_000

/** Never trust a window guess below this: flushing degenerates to per-piece adds. */
export const MIN_WINDOW_MS = 5 * 60_000

/** Floor for the flush margin, covering commit build + confirmation. */
export const MIN_MARGIN_MS = 10 * 60_000

export type FlushReason = 'batch-full' | 'window' | 'drained'

export interface FlushInput {
  /** Parked pieces currently awaiting commit on this provider. */
  batchSize: number
  /** Epoch ms of the oldest parked piece, or null when the batch is empty. */
  oldestParkedAtMs: number | null
  nowMs: number
  assumedWindowMs: number
  marginMs: number
  /** True when no further pieces will be parked (source drained). */
  drained: boolean
}

/** Decide whether the parked batch must be committed now, and why. */
export function shouldFlush(input: FlushInput): FlushReason | null {
  if (input.batchSize <= 0) return null
  if (input.batchSize >= MAX_ADD_PIECES_BATCH) return 'batch-full'
  if (
    input.oldestParkedAtMs != null &&
    input.nowMs >= input.oldestParkedAtMs + input.assumedWindowMs - input.marginMs
  ) {
    return 'window'
  }
  if (input.drained) return 'drained'
  return null
}

/**
 * Margin derived from confirmations observed earlier in the same run: a
 * constant cannot cover a congested chain. Doubling the worst observed commit
 * duration leaves room for one full retry; the floor covers the first flush
 * of a run, before any observation exists.
 */
export function marginFromConfirmations(observedCommitMs: number[], floorMs: number = MIN_MARGIN_MS): number {
  if (observedCommitMs.length === 0) return floorMs
  return Math.max(floorMs, 2 * Math.max(...observedCommitMs))
}

/**
 * Lower the assumed window after a detected GC. The collected piece survived
 * less than `collectedParkedAgeMs`, so the true window is at most that; 3/4
 * of it keeps the next guess strictly inside. Never raises the estimate.
 */
export function lowerWindowOnGc(assumedWindowMs: number, collectedParkedAgeMs: number): number {
  const fromEvidence = Math.floor((collectedParkedAgeMs * 3) / 4)
  return Math.max(MIN_WINDOW_MS, Math.min(assumedWindowMs, fromEvidence))
}

/**
 * The upload rate below which one max-size piece cannot be parked and
 * confirmed inside the window: the flow cannot work at all under this and
 * the caller should retain locally and upload in a burst instead.
 */
export function bandwidthFloorBytesPerSec(pieceSizeBytes: number, assumedWindowMs: number, marginMs: number): number {
  const usableMs = Math.max(1, assumedWindowMs - marginMs)
  return Math.ceil((pieceSizeBytes * 1000) / usableMs)
}

/**
 * Parse Curio's GC rejection out of a failed addPieces/commit error. Returns
 * the named sub-piece CID or null when the failure is something else. The
 * message conflates "not parked" with "wrong service", so the caller should
 * treat the result as evidence, not proof, and re-verify the whole batch
 * (Curio returns on the FIRST miss; several collected pieces surface one at
 * a time).
 */
export function collectedCidFromError(message: string): string | null {
  const match = message.match(/subPiece CID ([A-Za-z0-9]+) not found or does not belong to service/)
  return match?.[1] ?? null
}
