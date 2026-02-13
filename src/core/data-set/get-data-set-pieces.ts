/**
 * Get Data Set Pieces
 *
 * Functions for retrieving pieces from a dataset with optional metadata enrichment.
 *
 * @module core/data-set/get-data-set-pieces
 */

import { getSizeFromPieceCID } from '@filoz/synapse-core/piece'
import { getDataSet as getDataSetFromPDP } from '@filoz/synapse-core/sp'
import { type DataSetPieceData, METADATA_KEYS, type Synapse } from '@filoz/synapse-sdk'
import type { StorageContext } from '@filoz/synapse-sdk/storage'
import { WarmStorageService } from '@filoz/synapse-sdk/warm-storage'
import { reconcilePieceStatus } from '../piece/piece-status.js'
import type { Warning } from '../utils/types.js'
import { isStorageContextWithDataSetId } from './type-guards.js'
import type { DataSetPiecesResult, GetDataSetPiecesOptions, PieceInfo, StorageContextWithDataSetId } from './types.js'
import { PieceStatus } from './types.js'

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
  const warnings: Warning[] = []

  let scheduledRemovals: bigint[] = []
  let pdpServerPieces: DataSetPieceData[] | null = null
  try {
    scheduledRemovals = [...(await storageContext.getScheduledRemovals())]
    try {
      const serviceURL = storageContext.provider.pdp.serviceURL
      const dataSetId = storageContext.dataSetId
      if (dataSetId != null) {
        const dataSet = await getDataSetFromPDP({
          serviceURL,
          dataSetId,
        })
        pdpServerPieces = dataSet.pieces
      }
    } catch (error) {
      logger?.warn({ error }, 'Failed to fetch provider data for scheduled removals and orphan detection')
      warnings.push({
        code: 'PROVIDER_DATA_UNAVAILABLE',
        message: 'Failed to fetch provider data; orphan detection disabled',
        context: { dataSetId: storageContext.dataSetId, error: String(error) },
      })
    }
  } catch (error) {
    logger?.warn({ error }, 'Failed to get scheduled removals')
    warnings.push({
      code: 'SCHEDULED_REMOVALS_UNAVAILABLE',
      message: 'Failed to get scheduled removals',
      context: { dataSetId: storageContext.dataSetId, error: String(error) },
    })
  }

  // Use the async generator to fetch all pieces
  try {
    const getPiecesOptions: { batchSize?: bigint; signal?: AbortSignal } = {}
    if (signal) {
      getPiecesOptions.signal = signal
    }
    const providerPiecesById = pdpServerPieces ? new Map(pdpServerPieces.map((piece) => [piece.pieceId, piece])) : null
    for await (const piece of storageContext.getPieces(getPiecesOptions)) {
      const pieceId = piece.pieceId
      const pieceCid = piece.pieceCid
      const { status, warning } = reconcilePieceStatus({
        pieceId,
        pieceCid,
        scheduledRemovals,
        providerPiecesById,
      })
      const pieceInfo: PieceInfo = {
        pieceId,
        pieceCid: pieceCid.toString(),
        status,
      }
      if (warning) {
        warnings.push(warning)
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
    if (providerPiecesById !== null) {
      // reconcilePieceStatus removes provider matches as we stream on-chain pieces.
      // Remaining entries are only reported by the provider, which are off-chain orphans.
      for (const piece of providerPiecesById.values()) {
        // add the rest of the pieces to the pieces list
        pieces.push({
          pieceId: piece.pieceId,
          pieceCid: piece.pieceCid.toString(),
          status: PieceStatus.OFFCHAIN_ORPHANED,
        })
        warnings.push({
          code: 'OFFCHAIN_ORPHANED',
          message: 'Piece is reported by provider but not on-chain',
          context: { pieceId: piece.pieceId, pieceCid: piece.pieceCid.toString() },
        })
      }
    }
    pieces.sort((a, b) => Number(a.pieceId - b.pieceId))
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error
    }
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
  warnings: Warning[],
  logger?: GetDataSetPiecesOptions['logger']
): Promise<void> {
  const dataSetId = storageContext.dataSetId

  let warmStorage: WarmStorageService
  try {
    warmStorage = new WarmStorageService({ client: synapse.client })
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
      const metadata = await warmStorage.getPieceMetadata({
        dataSetId,
        pieceId: piece.pieceId,
      })

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
