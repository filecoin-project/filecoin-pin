/**
 * Get Data Set Pieces
 *
 * Functions for retrieving pieces from a dataset with optional metadata enrichment.
 *
 * @module core/data-set/get-data-set-pieces
 */

import { getSizeFromPieceCID } from '@filoz/synapse-core/piece'
import { METADATA_KEYS, PDPVerifier, type StorageContext, type Synapse, WarmStorageService } from '@filoz/synapse-sdk'
import { isStorageContextWithDataSetId } from './type-guards.js'
import type {
  DataSetPiecesResult,
  DataSetWarning,
  GetDataSetPiecesOptions,
  PieceInfo,
  StorageContextWithDataSetId,
} from './types.js'

/**
 * Get all pieces for a dataset from a StorageContext
 *
 * This function uses the StorageContext.getPieces() async generator to retrieve
 * all pieces in a dataset. Optionally fetches metadata for each piece from WarmStorage.
 *
 * Example usage:
 * ```typescript
 * const result = await getDataSetPieces(storageContext, {
 *   includeMetadata: true,
 *   batchSize: 100
 * })
 *
 * console.log(`Found ${result.pieces.length} pieces`)
 * for (const piece of result.pieces) {
 *   console.log(`  ${piece.pieceCid}`)
 *   if (piece.rootIpfsCid) {
 *     console.log(`    IPFS: ${piece.rootIpfsCid}`)
 *   }
 * }
 * ```
 *
 * @param storageContext - Storage context from upload or dataset resolution
 * @param options - Optional configuration
 * @returns Pieces and warnings
 */
export async function getDataSetPieces(
  synapse: Synapse,
  storageContext: StorageContext,
  options?: GetDataSetPiecesOptions
): Promise<DataSetPiecesResult> {
  const logger = options?.logger
  const includeMetadata = options?.includeMetadata ?? false
  const signal = options?.signal

  if (!isStorageContextWithDataSetId(storageContext)) {
    throw new Error('Storage context does not have a dataset ID')
  }

  const pieces: PieceInfo[] = []
  const warnings: DataSetWarning[] = []

  // call PDPVerifier.getScheduledRemovals to get the list of pieces that are scheduled for removal
  let scheduledRemovals: number[] = []
  try {
    const warmStorage = await WarmStorageService.create(synapse.getProvider(), synapse.getWarmStorageAddress())
    const pdpVerifier = new PDPVerifier(synapse.getProvider(), warmStorage.getPDPVerifierAddress())
    scheduledRemovals = await pdpVerifier.getScheduledRemovals(storageContext.dataSetId)
  } catch (error) {
    logger?.warn({ error }, 'Failed to create WarmStorageService or PDPVerifier for scheduled removals')
  }

  // Use the async generator to fetch all pieces
  try {
    const getPiecesOptions = { ...(signal && { signal }) }
    for await (const piece of storageContext.getPieces(getPiecesOptions)) {
      const pieceId = piece.pieceId
      const pieceCid = piece.pieceCid
      const pieceInfo: PieceInfo = {
        pieceId,
        pieceCid: pieceCid.toString(),
        isPendingRemoval: scheduledRemovals.includes(pieceId),
      }

      // Calculate piece size from CID
      try {
        pieceInfo.size = getSizeFromPieceCID(pieceCid)
      } catch (error) {
        logger?.warn(
          { pieceId: piece.pieceId, pieceCid: piece.pieceCid.toString(), error },
          'Failed to calculate piece size from CID'
        )
      }

      pieces.push(pieceInfo)
    }
  } catch (error) {
    // If getPieces fails completely, throw - this is a critical error
    logger?.error({ dataSetId: storageContext.dataSetId, error }, 'Failed to retrieve pieces from dataset')
    throw new Error(`Failed to retrieve pieces for dataset ${storageContext.dataSetId}: ${String(error)}`)
  }

  // Optionally enrich with metadata
  if (includeMetadata && pieces.length > 0) {
    await enrichPiecesWithMetadata(synapse, storageContext, pieces, warnings, logger)
  }

  // Calculate total size from pieces that have sizes
  const piecesWithSizes = pieces.filter((p): p is PieceInfo & { size: number } => p.size != null)

  const result: DataSetPiecesResult = {
    pieces,
    dataSetId: storageContext.dataSetId,
    warnings,
  }

  if (piecesWithSizes.length > 0) {
    result.totalSizeBytes = piecesWithSizes.reduce((sum, piece) => sum + BigInt(piece.size), 0n)
  }

  return result
}

/**
 * Internal helper: Enrich pieces with metadata from WarmStorage
 *
 * This function fetches metadata for each piece and extracts:
 * - rootIpfsCid (from METADATA_KEYS.IPFS_ROOT_CID)
 * - Full metadata object
 *
 * Non-fatal errors are added to the warnings array.
 */
async function enrichPiecesWithMetadata(
  synapse: Synapse,
  storageContext: StorageContextWithDataSetId,
  pieces: PieceInfo[],
  warnings: DataSetWarning[],
  logger?: GetDataSetPiecesOptions['logger']
): Promise<void> {
  const dataSetId = storageContext.dataSetId

  // Create WarmStorage service instance
  let warmStorage: WarmStorageService
  try {
    warmStorage = await WarmStorageService.create(synapse.getProvider(), synapse.getWarmStorageAddress())
  } catch (error) {
    // If we can't create the service, warn and return
    logger?.warn({ error }, 'Failed to create WarmStorageService for metadata enrichment')
    warnings.push({
      code: 'WARM_STORAGE_INIT_FAILED',
      message: 'Failed to initialize WarmStorageService for metadata enrichment',
      context: { error: String(error) },
    })
    return
  }

  // Fetch metadata for each piece
  for (const piece of pieces) {
    try {
      const metadata = await warmStorage.getPieceMetadata(dataSetId, piece.pieceId)

      // Extract root IPFS CID if available
      const rootIpfsCid = metadata[METADATA_KEYS.IPFS_ROOT_CID]
      if (rootIpfsCid) {
        piece.rootIpfsCid = rootIpfsCid
      }

      // Store full metadata
      piece.metadata = metadata
    } catch (error) {
      // Non-fatal: piece exists but metadata fetch failed
      logger?.warn(
        {
          dataSetId,
          pieceId: piece.pieceId,
          error,
        },
        'Failed to fetch metadata for piece'
      )

      warnings.push({
        code: 'METADATA_FETCH_FAILED',
        message: `Failed to fetch metadata for piece ${piece.pieceId}`,
        context: {
          pieceId: piece.pieceId,
          dataSetId,
          error: String(error),
        },
      })
    }
  }
}
