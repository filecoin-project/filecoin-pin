/**
 * Get Data Set Pieces
 *
 * Functions for retrieving pieces from a dataset with optional metadata enrichment.
 *
 * @module core/data-set/get-data-set-pieces
 */

import { getActivePieces, getScheduledRemovals } from '@filoz/synapse-core/pdp-verifier'
import { getSizeFromPieceCID } from '@filoz/synapse-core/piece'
import { getDataSet as getProviderDataSet } from '@filoz/synapse-core/sp'
import { getAllPieceMetadata } from '@filoz/synapse-core/warm-storage'
import { type DataSetPieceData, METADATA_KEYS, type Synapse } from '@filoz/synapse-sdk'
import { reconcilePieceStatus } from '../piece/piece-status.js'
import type { Warning } from '../utils/types.js'
import { type DataSetPiecesResult, type GetDataSetPiecesOptions, type PieceInfo, PieceStatus } from './types.js'

const ACTIVE_PIECES_BATCH_SIZE = 100n

/**
 * Get all pieces for a dataset.
 *
 * Fetches on-chain pieces via PDPVerifier and provider-side pieces from the
 * service URL, reconciles statuses, and optionally enriches with metadata.
 *
 * @param synapse - Initialized Synapse instance
 * @param dataSetId - Dataset ID to fetch pieces for
 * @param serviceURL - Provider PDP service URL for orphan detection
 * @param options - Optional configuration
 * @returns Pieces and warnings
 */
export async function getDataSetPieces(
  synapse: Synapse,
  dataSetId: bigint,
  serviceURL: string,
  options?: GetDataSetPiecesOptions
): Promise<DataSetPiecesResult> {
  const logger = options?.logger
  const includeMetadata = options?.includeMetadata ?? false

  const pieces: PieceInfo[] = []
  const warnings: Warning[] = []

  // Fetch scheduled removals and provider-side pieces in parallel
  let scheduledRemovals: readonly bigint[] = []
  let providerPiecesById: Map<bigint, DataSetPieceData> | null = null

  const [scheduledRemovalsResult, providerPiecesResult] = await Promise.allSettled([
    getScheduledRemovals(synapse.client, { dataSetId }),
    getProviderDataSet({ serviceURL, dataSetId }),
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

  // Fetch on-chain pieces (paginated) and reconcile with provider data
  try {
    let offset = 0n
    let hasMore = true
    while (hasMore) {
      const result = await getActivePieces(synapse.client, {
        dataSetId,
        offset,
        limit: ACTIVE_PIECES_BATCH_SIZE,
      })
      for (const piece of result.pieces) {
        const { status, warning } = reconcilePieceStatus({
          pieceId: piece.id,
          pieceCid: piece.cid,
          scheduledRemovals,
          providerPiecesById,
        })
        const pieceInfo: PieceInfo = {
          pieceId: piece.id,
          pieceCid: piece.cid.toString(),
          status,
        }
        if (warning) {
          warnings.push(warning)
        }

        try {
          pieceInfo.size = getSizeFromPieceCID(piece.cid)
        } catch (error) {
          logger?.warn(
            { pieceId: piece.id.toString(), pieceCid: piece.cid.toString(), error },
            'Failed to calculate piece size from CID'
          )
        }

        pieces.push(pieceInfo)
      }
      hasMore = result.hasMore
      offset += ACTIVE_PIECES_BATCH_SIZE
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
