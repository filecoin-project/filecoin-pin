/**
 * Remove All Pieces from a Data Set
 *
 * Core function for batch removing all pieces from a dataset.
 *
 * @module core/piece/remove-all-pieces
 */

import type { StorageContext, Synapse } from '@filoz/synapse-sdk'
import type { Logger } from 'pino'
import { getDataSetPieces } from '../data-set/get-data-set-pieces.js'
import { PieceStatus } from '../data-set/types.js'
import type { ProgressEvent, ProgressEventHandler } from '../utils/types.js'
import { removePiece } from './remove-piece.js'

/**
 * Progress events emitted during batch piece removal
 */
export type RemoveAllPiecesProgressEvents =
  | ProgressEvent<'remove-all:fetching', { dataSetId: number }>
  | ProgressEvent<'remove-all:fetched', { dataSetId: number; totalPieces: number }>
  | ProgressEvent<'remove-all:removing', { current: number; total: number; pieceCid: string }>
  | ProgressEvent<'remove-all:removed', { current: number; total: number; pieceCid: string; txHash: string }>
  | ProgressEvent<'remove-all:failed', { current: number; total: number; pieceCid: string; error: string }>
  | ProgressEvent<'remove-all:complete', { totalPieces: number; removedCount: number; failedCount: number }>

/**
 * Result of a single piece removal attempt
 */
export interface PieceRemovalResult {
  pieceCid: string
  txHash: string
  success: boolean
  error?: string
}

/**
 * Result of removing all pieces from a dataset
 */
export interface RemoveAllPiecesResult {
  dataSetId: number
  totalPieces: number
  removedCount: number
  failedCount: number
  transactions: PieceRemovalResult[]
}

/**
 * Options for removing all pieces
 */
export interface RemoveAllPiecesOptions {
  /** Initialized Synapse SDK instance */
  synapse: Synapse
  /** Optional progress event handler for tracking removal status */
  onProgress?: ProgressEventHandler<RemoveAllPiecesProgressEvents>
  /** Whether to wait for each transaction confirmation before proceeding (default: false) */
  waitForConfirmation?: boolean
  /** Optional logger for tracking removal operations */
  logger?: Logger
}

/**
 * Remove all pieces from a Data Set
 *
 * @example
 * ```typescript
 * const result = await removeAllPieces(storageContext, {
 *   synapse,
 *   onProgress: (event) => console.log(event.type, event.data),
 * })
 * console.log(`Removed ${result.removedCount}/${result.totalPieces} pieces`)
 * ```
 *
 * Process:
 * 1. Fetch all pieces from the dataset using getDataSetPieces
 * 2. Iterate through each piece and call removePiece
 * 3. Track success/failure for each removal
 * 4. Return aggregated results
 *
 * @param storageContext - Storage context bound to a Data Set
 * @param options - Configuration including synapse instance and callbacks
 * @returns Aggregated removal results
 */
export async function removeAllPieces(
  storageContext: StorageContext,
  options: RemoveAllPiecesOptions
): Promise<RemoveAllPiecesResult> {
  const { synapse, onProgress, waitForConfirmation = false, logger } = options
  const dataSetId = storageContext.dataSetId

  if (dataSetId == null) {
    throw new Error(
      'Storage context must be bound to a Data Set before removing pieces. Use createStorageContext with dataset.useExisting to bind to a Data Set.'
    )
  }

  // Fetch all pieces from the dataset
  onProgress?.({ type: 'remove-all:fetching', data: { dataSetId } })

  const { pieces: allPieces } = await getDataSetPieces(synapse, storageContext, { logger })

  // Filter out pieces that are already pending removal - no need to delete them again
  const pieces = allPieces.filter((p) => p.status === PieceStatus.ACTIVE)
  const totalPieces = pieces.length
  const skippedCount = allPieces.length - pieces.length

  if (skippedCount > 0) {
    logger?.info({ skipped: skippedCount, total: allPieces.length }, 'Skipped pieces already pending removal')
  }

  onProgress?.({ type: 'remove-all:fetched', data: { dataSetId, totalPieces } })

  if (totalPieces === 0) {
    onProgress?.({ type: 'remove-all:complete', data: { totalPieces: 0, removedCount: 0, failedCount: 0 } })
    return {
      dataSetId,
      totalPieces: 0,
      removedCount: 0,
      failedCount: 0,
      transactions: [],
    }
  }

  // Remove each piece
  const transactions: PieceRemovalResult[] = []
  let removedCount = 0
  let failedCount = 0

  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]
    if (!piece) continue

    const current = i + 1
    const pieceCid = piece.pieceCid

    onProgress?.({ type: 'remove-all:removing', data: { current, total: totalPieces, pieceCid } })

    try {
      const txHash = await removePiece(pieceCid, storageContext, {
        synapse,
        waitForConfirmation,
        logger,
      })

      transactions.push({ pieceCid, txHash, success: true })
      removedCount++

      onProgress?.({ type: 'remove-all:removed', data: { current, total: totalPieces, pieceCid, txHash } })

      logger?.info({ pieceCid, txHash, current, total: totalPieces }, 'Piece removed successfully')
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      transactions.push({ pieceCid, txHash: '', success: false, error: errorMessage })
      failedCount++

      onProgress?.({ type: 'remove-all:failed', data: { current, total: totalPieces, pieceCid, error: errorMessage } })

      logger?.error({ pieceCid, error, current, total: totalPieces }, 'Failed to remove piece')
    }
  }

  onProgress?.({ type: 'remove-all:complete', data: { totalPieces, removedCount, failedCount } })

  return {
    dataSetId,
    totalPieces,
    removedCount,
    failedCount,
    transactions,
  }
}
