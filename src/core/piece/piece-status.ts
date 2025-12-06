import type { DataSetPieceData } from '@filoz/synapse-sdk'
import { PieceStatus } from '../data-set/types.js'
import type { Warning } from '../utils/types.js'

interface PieceStatusContext {
  pieceId: number
  pieceCid: unknown
  /**
   * List of pieceIds that are scheduled for removal.
   *
   * This list is obtained from the PDPVerifier.getScheduledRemovals() method.
   */
  scheduledRemovals: number[]
  /**
   * Map of provider-reported pieces keyed by pieceId.
   *
   * This map is mutated: when we confirm a piece is both on-chain and reported
   * by the provider, we delete it so leftovers represent provider-only pieces.
   */
  providerPiecesById: Map<DataSetPieceData['pieceId'], DataSetPieceData> | null
}

interface PieceStatusResult {
  status: PieceStatus
  warning?: Warning
}

/**
 * Reconcile a piece's status across the two data sources we have:
 *
 * - On-chain: StorageContext.getPieces() (source of truth for what the PDP verifier knows)
 * - Provider-reported: PDPServer.getDataSet() (what the storage provider says it stores)
 *
 * https://github.com/filecoin-project/curio/issues/815 showed these can drift. This helper documents the rules we apply
 * to flag mismatches without blocking the listing flow:
 *
 * 1. If PDPVerifier marked the piece for removal, treat as PENDING_REMOVAL.
 * 2. If provider data is unavailable, assume ACTIVE (best effort).
 * 3. If provider reports the piece, treat as ACTIVE and remove it from the map so
 *    any leftover entries become OFFCHAIN_ORPHANED later.
 * 4. Otherwise, the piece is on-chain but missing from the provider => ONCHAIN_ORPHANED.
 *
 * The optional warning conveys orphan cases to callers for user-facing messaging.
 */
export function reconcilePieceStatus(context: PieceStatusContext): PieceStatusResult {
  const { pieceId, pieceCid, scheduledRemovals, providerPiecesById } = context

  if (scheduledRemovals.includes(pieceId)) {
    return { status: PieceStatus.PENDING_REMOVAL }
  }

  if (providerPiecesById === null) {
    // No provider data to compare against; assume the on-chain view is accurate.
    return { status: PieceStatus.ACTIVE }
  }

  if (providerPiecesById.has(pieceId)) {
    // Provider matches on-chain; remove so leftovers can be flagged as off-chain orphans.
    providerPiecesById.delete(pieceId)
    return { status: PieceStatus.ACTIVE }
  }

  return {
    status: PieceStatus.ONCHAIN_ORPHANED,
    warning: {
      code: 'ONCHAIN_ORPHANED',
      message: 'Piece is on-chain but the provider does not report it',
      context: { pieceId, pieceCid },
    },
  }
}
