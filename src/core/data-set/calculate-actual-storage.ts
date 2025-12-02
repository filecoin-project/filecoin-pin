/**
 * Calculate actual storage across all data sets for an address.
 * More accurate than billing-derived estimates, especially when floor pricing
 * skews small files.
 */
import type { Synapse } from '@filoz/synapse-sdk'
import PQueue from 'p-queue'
import type { Logger } from 'pino'
import { createStorageContextFromDataSetId } from '../synapse/storage-context-helper.js'
import type { ProgressEvent, ProgressEventHandler } from '../utils/types.js'
import { getDataSetPieces } from './get-data-set-pieces.js'
import type { DataSetSummary, DataSetWarning } from './types.js'

export interface ActualStorageResult {
  /** Total storage in bytes across all active data sets */
  totalBytes: bigint
  /** Number of active data sets found */
  dataSetCount: number
  /** Number of data sets successfully processed */
  dataSetsProcessed: number
  /** Total number of pieces across all data sets */
  pieceCount: number
  /** Whether the calculation timed out */
  timedOut?: boolean
  /** Non-fatal warnings encountered during calculation */
  warnings: DataSetWarning[]
}

export type ActualStorageProgressEvents = ProgressEvent<
  'actual-storage:progress',
  { dataSetsProcessed: number; dataSetCount: number; pieceCount: number; totalBytes: bigint }
>

/**
 * Get a unique Provider-scoped key for a data set
 * @param dataSet - The data set to get the key for
 * @returns The unique Provider-scoped key for the data set
 */
const getProviderKey = ({ providerId, serviceProvider, dataSetId }: DataSetSummary): string | number => {
  if (providerId !== undefined) {
    return providerId
  }
  if (serviceProvider) {
    return serviceProvider
  }
  return `unknown-${dataSetId}`
}

/**
 * Calculate actual storage from all active data sets for an address
 *
 * This function queries all active/live data sets and sums up the actual piece sizes.
 * It's more accurate than deriving storage from billing rates, but can be slow for
 * users with many pieces.
 *
 * The calculation respects abort signals - if aborted, it will return partial results
 * with a timedOut flag set to true.
 *
 * Example usage:
 * ```typescript
 * const result = await calculateActualStorage(synapse, {
 *   address: '0x1234...',
 *   signal: AbortSignal.timeout(30000), // 30 second timeout
 *   logger: myLogger
 * })
 *
 * console.log(`Total storage: ${result.totalBytes} bytes`)
 * console.log(`Across ${result.dataSetsProcessed}/${result.dataSetCount} data sets`)
 * console.log(`Total pieces: ${result.pieceCount}`)
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
    /** Max number of providers to query in parallel (defaults to 10) */
    maxParallelProviders?: number
    /** Max concurrent datasets per provider (defaults to 10) */
    maxParallelPerProvider?: number
    /** Progress callback for UI updates */
    onProgress?: ProgressEventHandler<ActualStorageProgressEvents>
  }
): Promise<ActualStorageResult> {
  const logger = options?.logger
  const address = options?.address ?? (await synapse.getClient().getAddress())
  const signal = options?.signal
  const maxParallelProviders = Math.max(1, options?.maxParallelProviders ?? 10)
  const maxParallelPerProvider = Math.max(1, options?.maxParallelPerProvider ?? 10)
  const onProgress = options?.onProgress

  const warnings: DataSetWarning[] = []
  let totalBytes = 0n
  let pieceCount = 0
  let dataSetsProcessed = 0
  let dataSetCount = 0
  // Process data sets with provider-scoped concurrency (one at a time per provider)
  const globalQueue = new PQueue({ concurrency: maxParallelProviders })
  const providerQueues = new Map<string | number, PQueue>()

  if (signal) {
    signal.addEventListener(
      'abort',
      () => {
        logger?.warn({ reason: signal.reason }, 'Abort signal received during storage calculation')
        globalQueue.clear()
        providerQueues.forEach((queue) => {
          queue.clear()
        })
      },
      { once: true }
    )
  }

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

    const processDataSet = async (dataSet: (typeof dataSets)[number]): Promise<void> => {
      signal?.throwIfAborted()

      try {
        const { storage: storageContext } = await createStorageContextFromDataSetId(synapse, dataSet.dataSetId)

        signal?.throwIfAborted()

        const getPiecesOptions: { logger?: Logger; signal?: AbortSignal } = {}
        if (logger) {
          getPiecesOptions.logger = logger
        }
        if (signal) {
          getPiecesOptions.signal = signal
        }
        const result = await getDataSetPieces(synapse, storageContext, getPiecesOptions)

        if (result.totalSizeBytes) {
          totalBytes += result.totalSizeBytes
        }

        pieceCount += result.pieces.length
        dataSetsProcessed++

        if (result.warnings && result.warnings.length > 0) {
          warnings.push(...result.warnings)
        }

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
        if (error instanceof Error && error.name === 'AbortError') {
          logger?.warn('Piece retrieval aborted')
          throw error // Re-throw AbortError to propagate cancellation
        }

        const errorMessage = error instanceof Error ? error.message : String(error)
        logger?.warn({ dataSetId: dataSet.dataSetId, error: errorMessage }, 'Failed to get pieces for data set')

        warnings.push({
          code: 'DATA_SET_QUERY_FAILED',
          message: `Failed to query pieces for data set ${dataSet.dataSetId}`,
          context: {
            dataSetId: dataSet.dataSetId,
            error: errorMessage,
          },
        })
      }
    }

    const scheduledPromises = dataSets.map((dataSet) => {
      const providerKey = getProviderKey(dataSet)
      let providerQueue = providerQueues.get(providerKey)
      if (!providerQueue) {
        providerQueue = new PQueue({ concurrency: maxParallelPerProvider })
        providerQueues.set(providerKey, providerQueue)
      }

      const jobOptions: { signal?: AbortSignal } = signal ? { signal } : {}

      return globalQueue.add(() => providerQueue.add(() => processDataSet(dataSet), jobOptions), jobOptions)
    })

    const allResults = Promise.allSettled(scheduledPromises)
    const abortRace =
      signal != null
        ? new Promise<'aborted'>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                resolve('aborted')
              },
              { once: true }
            )
          })
        : null

    const results = (await (abortRace ? Promise.race([allResults, abortRace]) : allResults)) as
      | PromiseSettledResult<void>[]
      | 'aborted'

    // Check if any AbortErrors occurred
    if (Array.isArray(results)) {
      for (const result of results) {
        if (result.status === 'rejected') {
          const reason = result.reason
          if (reason instanceof Error && reason.name !== 'AbortError') {
            logger?.warn({ error: String(reason) }, 'Dataset processing failed')
          }
        }
      }
    }

    // Derive timedOut from signal state
    const timedOut = signal?.aborted ?? false

    if (timedOut) {
      logger?.warn({ dataSetsProcessed, totalDataSets: dataSets.length }, 'Calculation aborted')
      warnings.push({
        code: 'CALCULATION_ABORTED',
        message: `Calculation aborted after processing ${dataSetsProcessed}/${dataSetCount} data sets`,
        context: {
          dataSetsProcessed,
          totalDataSets: dataSetCount,
        },
      })
    }

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
