import type { DataSetPieceData } from '@filoz/synapse-sdk'
import { PieceStatus } from '../data-set/types.js'
import type { Warning } from '../utils/types.js'

interface PieceStatusContext {
  pieceId: bigint
  pieceCid: unknown
  /**
   * List of pieceIds that are scheduled for removal.
   */
  scheduledRemovals: readonly bigint[]
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
 * Reconcile a piece's status across on-chain and provider-reported data.
 *
 * On-chain (StorageContext.getPieces()) and provider-reported (PDPServer.getDataSet())
 * views can drift -- see https://github.com/filecoin-project/curio/issues/815.
 *
 * Rules:
 * 1. If PDPVerifier marked the piece for removal => PENDING_REMOVAL
 * 2. If provider data is unavailable, assume ACTIVE (best effort)
 * 3. If provider reports the piece => ACTIVE (remove from map for orphan detection)
 * 4. Otherwise, on-chain but missing from provider => ONCHAIN_ORPHANED
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
    // Provider confirms this piece; remove from map so leftovers become off-chain orphans.
    providerPiecesById.delete(pieceId)
    return { status: PieceStatus.ACTIVE }
  }

  return {
    status: PieceStatus.ONCHAIN_ORPHANED,
    warning: {
      code: 'ONCHAIN_ORPHANED',
      message: 'Piece is on-chain but the provider does not report it',
      context: { pieceId: pieceId.toString(), pieceCid },
    },
  }
}
