/**
 * Get Data Set Pieces
 *
 * Functions for retrieving pieces from a dataset with optional metadata enrichment.
 *
 * @module core/data-set/get-data-set-pieces
 */

import { getSizeFromPieceCID } from '@filoz/synapse-core/piece'
import { getDataSet as getProviderDataSet } from '@filoz/synapse-core/sp'
import { getAllPieceMetadata } from '@filoz/synapse-core/warm-storage'
import { type DataSetPieceData, METADATA_KEYS, type Synapse } from '@filoz/synapse-sdk'
import type { StorageContext } from '@filoz/synapse-sdk/storage'
import { reconcilePieceStatus } from '../piece/piece-status.js'
import type { Warning } from '../utils/types.js'
import { type DataSetPiecesResult, type GetDataSetPiecesOptions, type PieceInfo, PieceStatus } from './types.js'

/**
 * Get all pieces for a dataset from a StorageContext
 *
 * Uses StorageContext.getPieces() async generator to retrieve all pieces.
 * Optionally fetches metadata for each piece from WarmStorage.
 *
 * @param synapse - Initialized Synapse instance
 * @param storageContext - Storage context bound to a dataset
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

  if (storageContext.dataSetId == null) {
    throw new Error('Storage context does not have a dataset ID')
  }
  const dataSetId = storageContext.dataSetId

  const pieces: PieceInfo[] = []
  const warnings: Warning[] = []

  // Fetch scheduled removals and provider-side pieces in parallel
  let scheduledRemovals: readonly bigint[] = []
  let providerPiecesById: Map<bigint, DataSetPieceData> | null = null

  const [scheduledRemovalsResult, providerPiecesResult] = await Promise.allSettled([
    storageContext.getScheduledRemovals(),
    getProviderDataSet({
      serviceURL: storageContext.provider.pdp?.serviceURL ?? '',
      dataSetId,
    }),
  ])

  if (scheduledRemovalsResult.status === 'fulfilled') {
    scheduledRemovals = scheduledRemovalsResult.value
  } else {
    logger?.warn({ error: scheduledRemovalsResult.reason }, 'Failed to get scheduled removals')
    warnings.push({
      code: 'SCHEDULED_REMOVALS_UNAVAILABLE',
      message: 'Failed to get scheduled removals',
      context: { dataSetId: dataSetId.toString(), error: String(scheduledRemovalsResult.reason) },
    })
  }

  if (providerPiecesResult.status === 'fulfilled') {
    providerPiecesById = new Map(providerPiecesResult.value.pieces.map((p) => [p.pieceId, p]))
  } else {
    logger?.warn({ error: providerPiecesResult.reason }, 'Failed to get provider-side pieces for orphan detection')
    warnings.push({
      code: 'PROVIDER_PIECES_UNAVAILABLE',
      message: 'Failed to fetch provider-side pieces',
      context: { dataSetId: dataSetId.toString(), error: String(providerPiecesResult.reason) },
    })
  }

  // Fetch on-chain pieces and reconcile with provider data
  try {
    for await (const piece of storageContext.getPieces()) {
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
          { pieceId: piece.pieceId.toString(), pieceCid: piece.pieceCid.toString(), error },
          'Failed to calculate piece size from CID'
        )
      }

      pieces.push(pieceInfo)
    }

    // Leftover entries in providerPiecesById are pieces the provider reports
    // but that are not on-chain (offchain orphans)
    if (providerPiecesById) {
      for (const [pieceId, providerPiece] of providerPiecesById) {
        const pieceInfo: PieceInfo = {
          pieceId,
          pieceCid: providerPiece.pieceCid.toString(),
          status: PieceStatus.OFFCHAIN_ORPHANED,
        }
        try {
          pieceInfo.size = getSizeFromPieceCID(providerPiece.pieceCid)
        } catch {
          // size calculation is best-effort
        }
        pieces.push(pieceInfo)
        warnings.push({
          code: 'OFFCHAIN_ORPHANED',
          message: 'Piece reported by provider but not found on-chain',
          context: { pieceId: pieceId.toString(), pieceCid: providerPiece.pieceCid.toString() },
        })
      }
    }

    pieces.sort((a, b) => Number(a.pieceId - b.pieceId))
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error
    }
    logger?.error({ dataSetId: dataSetId.toString(), error }, 'Failed to retrieve pieces from dataset')
    throw new Error(`Failed to retrieve pieces for dataset ${dataSetId}: ${String(error)}`)
  }

  // Optionally enrich with metadata
  if (includeMetadata && pieces.length > 0) {
    await enrichPiecesWithMetadata(synapse, dataSetId, pieces, warnings, logger)
  }

  // Calculate total size from pieces that have sizes
  const piecesWithSizes = pieces.filter((p): p is PieceInfo & { size: number } => p.size != null)

  const result: DataSetPiecesResult = {
    pieces,
    dataSetId: dataSetId,
    warnings,
  }

  if (piecesWithSizes.length > 0) {
    result.totalSizeBytes = piecesWithSizes.reduce((sum, piece) => sum + BigInt(piece.size), 0n)
  }

  return result
}

/**
 * Internal helper: Enrich pieces with metadata from WarmStorage via synapse-core
 */
async function enrichPiecesWithMetadata(
  synapse: Synapse,
  dataSetId: bigint,
  pieces: PieceInfo[],
  warnings: Warning[],
  logger?: GetDataSetPiecesOptions['logger']
): Promise<void> {
  for (const piece of pieces) {
    try {
      const metadata = await getAllPieceMetadata(synapse.client, { dataSetId, pieceId: piece.pieceId })

      const rootIpfsCid = metadata[METADATA_KEYS.IPFS_ROOT_CID]
      if (rootIpfsCid) {
        piece.rootIpfsCid = rootIpfsCid
      }

      piece.metadata = metadata
    } catch (error) {
      logger?.warn(
        { dataSetId: dataSetId.toString(), pieceId: piece.pieceId.toString(), error },
        'Failed to fetch metadata for piece'
      )
      warnings.push({
        code: 'METADATA_FETCH_FAILED',
        message: `Failed to fetch metadata for piece ${piece.pieceId}`,
        context: {
          pieceId: piece.pieceId.toString(),
          dataSetId: dataSetId.toString(),
          error: String(error),
        },
      })
    }
  }
}
