import { getDataSetSizes } from '@filoz/synapse-core/pdp-verifier'
import type { Synapse } from '@filoz/synapse-sdk'
import type { Logger } from 'pino'
import { getClientAddress } from '../synapse/index.js'
import type { ProgressEvent, ProgressEventHandler, Warning } from '../utils/types.js'
import type { DataSetSummary } from './types.js'

export interface ActualStorageResult {
  /** Total storage in bytes across all active data sets */
  totalBytes: bigint
  /** Number of active data sets found */
  dataSetCount: number
  /** Number of data sets successfully processed */
  dataSetsProcessed: number
  /** Total number of pieces across all data sets. Not queried by the optimized storage total path. */
  pieceCount: number
  /** Whether the calculation timed out */
  timedOut?: boolean
  /** Non-fatal warnings encountered during calculation */
  warnings: Warning[]
}

export type ActualStorageProgressEvents = ProgressEvent<
  'actual-storage:progress',
  { dataSetsProcessed: number; dataSetCount: number; pieceCount: number; totalBytes: bigint }
>

const FR32_DATA_BYTES = 127n
const FR32_EXPANDED_BYTES = 128n

function unexpandDataSetSize(expandedLeafBytes: bigint): bigint {
  return (expandedLeafBytes * FR32_DATA_BYTES) / FR32_EXPANDED_BYTES
}

/**
 * Calculate actual storage from all active data sets for an address
 *
 * This function queries aggregate on-chain data set sizes and sums the unexpanded
 * leaf-count approximation used for billing. `getDataSetSizes()` currently returns
 * FR32-expanded leaf bytes, so this converts 128 expanded bytes back to 127 raw
 * data bytes locally. The result naturally excludes OFFCHAIN_ORPHANED pieces
 * because those pieces were never written on-chain.
 *
 * The calculation respects abort signals - if aborted, it will return partial results
 * with a timedOut flag set to true.
 *
 * Example usage:
 * ```typescript
 * const result = await calculateActualStorage(synapse, dataSets, {
 *   address: '0x1234...',
 *   signal: AbortSignal.timeout(30000), // 30 second timeout
 *   logger: myLogger
 * })
 *
 * console.log(`Total storage: ${result.totalBytes} bytes`)
 * console.log(`Across ${result.dataSetsProcessed}/${result.dataSetCount} data sets`)
 *
 * if (result.timedOut) {
 *   console.warn('Calculation was aborted, results may be incomplete')
 * }
 *
 * if (result.warnings.length > 0) {
 *   console.warn('Encountered warnings:', result.warnings)
 * }
 * ```
 *
 * @param synapse - Initialized Synapse instance
 * @param options - Configuration options
 * @returns Actual storage calculation result
 */
export async function calculateActualStorage(
  synapse: Synapse,
  dataSets: DataSetSummary[],
  options?: {
    /** Address to calculate storage for (defaults to synapse client address) */
    address?: string
    /** Abort signal for cancellation/timeout (optional) */
    signal?: AbortSignal
    /** Logger for debugging (optional) */
    logger?: Logger
    /** @deprecated Kept for compatibility; aggregate storage calculation does not query providers. */
    maxParallelProviders?: number
    /** @deprecated Kept for compatibility; aggregate storage calculation does not query providers. */
    maxParallelPerProvider?: number
    /** Progress callback for UI updates */
    onProgress?: ProgressEventHandler<ActualStorageProgressEvents>
  }
): Promise<ActualStorageResult> {
  const logger = options?.logger
  const address = options?.address ?? getClientAddress(synapse)
  const signal = options?.signal
  const onProgress = options?.onProgress

  const warnings: Warning[] = []
  let totalBytes = 0n
  const pieceCount = 0
  let dataSetsProcessed = 0
  let dataSetCount = 0

  try {
    dataSetCount = dataSets.length

    if (dataSetCount === 0) {
      return {
        totalBytes: 0n,
        dataSetCount,
        dataSetsProcessed: 0,
        pieceCount: 0,
        warnings,
      }
    }

    logger?.info({ dataSetCount: dataSets.length, address }, 'Calculating actual storage across data sets')
    signal?.throwIfAborted()

    const dataSetIds = dataSets.map((dataSet) => dataSet.dataSetId)

    try {
      const expandedSizes = await getDataSetSizes(synapse.client, { dataSetIds })
      signal?.throwIfAborted()

      totalBytes = expandedSizes.reduce((sum, expandedSize) => sum + unexpandDataSetSize(expandedSize), 0n)
      dataSetsProcessed = expandedSizes.length

      onProgress?.({
        type: 'actual-storage:progress',
        data: {
          dataSetsProcessed,
          dataSetCount,
          pieceCount,
          totalBytes,
        },
      })
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error
      }

      const errorMessage = error instanceof Error ? error.message : String(error)
      logger?.warn({ error: errorMessage, dataSetIds }, 'Failed to query data set sizes')
      warnings.push({
        code: 'DATA_SET_QUERY_FAILED',
        message: 'Failed to query aggregate data set sizes',
        context: {
          dataSetIds: dataSetIds.map((id) => id.toString()),
          error: errorMessage,
        },
      })
    }

    const timedOut = signal?.aborted ?? false

    logger?.info(
      {
        totalBytes: totalBytes.toString(),
        dataSetCount,
        dataSetsProcessed,
        pieceCount,
        timedOut,
      },
      'Actual storage calculation complete'
    )

    return {
      totalBytes,
      dataSetCount,
      dataSetsProcessed,
      pieceCount,
      timedOut,
      warnings,
    }
  } catch (error) {
    // Check if this was an abort
    const isAborted = signal?.aborted || (error instanceof Error && error.name === 'AbortError')

    if (isAborted) {
      logger?.warn({ error }, 'Storage calculation aborted; returning partial results')
      if (!warnings.some((w) => w.code === 'CALCULATION_ABORTED')) {
        warnings.push({
          code: 'CALCULATION_ABORTED',
          message: `Calculation aborted after processing ${dataSetsProcessed}/${dataSetCount} data sets`,
          context: {
            dataSetsProcessed,
            totalDataSets: dataSetCount,
          },
        })
      }

      return {
        totalBytes,
        dataSetCount,
        dataSetsProcessed,
        pieceCount,
        timedOut: true,
        warnings,
      }
    }

    const errorMessage = error instanceof Error ? error.message : String(error)
    logger?.error({ error: errorMessage }, 'Failed to calculate actual storage')

    throw new Error(`Failed to calculate actual storage: ${errorMessage}`)
  }
}
