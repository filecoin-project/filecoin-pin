/**
 * Get Data Set Pieces
 *
 * Functions for retrieving pieces from a dataset.
 *
 * @module core/data-set/get-data-set-pieces
 */

import { getActivePieces, getScheduledRemovals } from '@filoz/synapse-core/pdp-verifier'
import { from as pieceFromCID } from '@filoz/synapse-core/piece'
import { getDataSet as getProviderDataSet } from '@filoz/synapse-core/sp'
import type { DataSetPieceData, Synapse } from '@filoz/synapse-sdk'
import { reconcilePieceStatus } from '../piece/piece-status.js'
import type { Warning } from '../utils/types.js'
import {
  type DataSetPiecesResult,
  type GetDataSetPiecesOptions,
  type IterateDataSetPiecesResult,
  type PieceInfo,
  PieceStatus,
} from './types.js'

const ACTIVE_PIECES_BATCH_SIZE = 100n

/**
 * Lazily iterate over pieces in a dataset in on-chain batches.
 *
 * Provider-side piece data is still fetched once up front for reconciliation;
 * the expensive on-chain piece walk is yielded one batch at a time.
 *
 * @param synapse - Initialized Synapse instance
 * @param dataSetId - Dataset ID to fetch pieces for
 * @param serviceURL - Provider PDP service URL for orphan detection
 * @param options - Optional configuration
 * @yields Reconciled piece batches and non-fatal warnings for each batch
 */
export async function* iterateDataSetPieces(
  synapse: Synapse,
  dataSetId: bigint,
  serviceURL: string,
  options?: GetDataSetPiecesOptions
): AsyncGenerator<IterateDataSetPiecesResult> {
  const logger = options?.logger
  const initialWarnings: Warning[] = []

  // Fetch scheduled removals and provider-side pieces in parallel.
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
    initialWarnings.push({
      code: 'SCHEDULED_REMOVALS_UNAVAILABLE',
      message: 'Failed to get scheduled removals',
      context: { dataSetId: dataSetId.toString(), error: String(scheduledRemovalsResult.reason) },
    })
  }

  if (providerPiecesResult.status === 'fulfilled') {
    providerPiecesById = new Map(providerPiecesResult.value.pieces.map((p) => [p.pieceId, p]))
  } else {
    logger?.warn({ error: providerPiecesResult.reason }, 'Failed to get provider-side pieces for orphan detection')
    initialWarnings.push({
      code: 'PROVIDER_PIECES_UNAVAILABLE',
      message: 'Failed to fetch provider-side pieces',
      context: { dataSetId: dataSetId.toString(), error: String(providerPiecesResult.reason) },
    })
  }

  try {
    let offset = 0n
    let hasMore = true

    while (hasMore) {
      options?.signal?.throwIfAborted()
      const warnings = initialWarnings.splice(0)
      const pieces: PieceInfo[] = []

      /**
       * TODO:
       * Replace `getActivePieces` with `getActivePiecesByCursor` once it's available in synapse-core.
       * This will allow for more efficient pagination and avoid potential issues with large datasets.
       * ref: https://github.com/FilOzone/synapse-sdk/issues/848
       */
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
          pieceInfo.size = pieceFromCID(piece.cid).size
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

      // Leftover entries in providerPiecesById are pieces the provider reports
      // but that are not on-chain (offchain orphans). These are only known once
      // the on-chain walk reaches the end.
      if (!hasMore && providerPiecesById) {
        for (const [pieceId, providerPiece] of providerPiecesById) {
          const pieceInfo: PieceInfo = {
            pieceId,
            pieceCid: providerPiece.pieceCid.toString(),
            status: PieceStatus.OFFCHAIN_ORPHANED,
          }
          try {
            pieceInfo.size = pieceFromCID(providerPiece.pieceCid).size
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

      yield {
        dataSetId,
        pieces,
        hasMore,
        warnings,
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error
    }
    logger?.error({ dataSetId: dataSetId.toString(), error }, 'Failed to retrieve pieces from dataset')
    throw new Error(`Failed to retrieve pieces for dataset ${dataSetId}: ${String(error)}`)
  }
}

/**
 * Get all pieces for a dataset.
 *
 * Fetches on-chain pieces via PDPVerifier and provider-side pieces from the
 * service URL, and reconciles statuses.
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
  const pieces: PieceInfo[] = []
  const warnings: Warning[] = []

  for await (const batch of iterateDataSetPieces(synapse, dataSetId, serviceURL, options)) {
    pieces.push(...batch.pieces)
    warnings.push(...batch.warnings)
  }

  pieces.sort((a, b) => Number(a.pieceId - b.pieceId))

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
