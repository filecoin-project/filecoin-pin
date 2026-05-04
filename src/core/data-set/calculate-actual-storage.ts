import { PDPVerifier, type Synapse, WarmStorageService } from '@filoz/synapse-sdk'
import PQueue from 'p-queue'
import type { Logger } from 'pino'
import { PDP_LEAF_SIZE } from '../payments/constants.js'
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
  /** Total number of pieces across all data sets */
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

/**
 * Get a unique Provider-scoped key for a data set
 * @param dataSet - The data set to get the key for
 * @returns The unique Provider-scoped key for the data set
 */
const getProviderKey = ({ providerId, serviceProvider, dataSetId }: DataSetSummary): string => {
  if (providerId !== undefined) {
    return providerId.toString()
  }
  if (serviceProvider) {
    return serviceProvider
  }
  return `unknown-${dataSetId}`
}

/**
 * Calculate actual storage from all active data sets for an address
 *
 * This function queries all active/live data sets and sums up their PDP leaf counts.
 * It avoids fetching per-piece details, which makes it much faster than walking every
 * piece in every data set.
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
  const address = options?.address ?? getClientAddress(synapse)
  const signal = options?.signal
  const maxParallelProviders = Math.max(1, options?.maxParallelProviders ?? 10)
  const maxParallelPerProvider = Math.max(1, options?.maxParallelPerProvider ?? 10)
  const onProgress = options?.onProgress

  const warnings: Warning[] = []
  let totalBytes = 0n
  let pieceCount = 0
  let dataSetsProcessed = 0
  let dataSetCount = 0
  // Process data sets with provider-scoped concurrency (one at a time per provider)
  const globalQueue = new PQueue({ concurrency: maxParallelProviders })
  const providerQueues = new Map<string, PQueue>()

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
    signal?.throwIfAborted()

    const warmStorage = await WarmStorageService.create(synapse.getProvider(), synapse.getWarmStorageAddress())
    const pdpVerifier = new PDPVerifier(synapse.getProvider(), warmStorage.getPDPVerifierAddress())

    const processDataSet = async (dataSet: (typeof dataSets)[number]): Promise<void> => {
      signal?.throwIfAborted()

      try {
        const dataSetId = Number(dataSet.dataSetId)
        const leafCount = await pdpVerifier.getDataSetLeafCount(dataSetId)
        const dataSetBytes = BigInt(leafCount) * BigInt(PDP_LEAF_SIZE)
        totalBytes += dataSetBytes
        pieceCount += dataSet.currentPieceCount ?? 0
        dataSetsProcessed++

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
          logger?.warn('Leaf count retrieval aborted')
          throw error // Re-throw AbortError to propagate cancellation
        }

        const errorMessage = error instanceof Error ? error.message : String(error)
        logger?.warn({ dataSetId: dataSet.dataSetId, error: errorMessage }, 'Failed to get leaf count for data set')

        warnings.push({
          code: 'DATA_SET_QUERY_FAILED',
          message: `Failed to query leaf count for data set ${dataSet.dataSetId}`,
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

    await (signal
      ? Promise.race([Promise.allSettled(scheduledPromises), waitForAbort(signal)])
      : Promise.allSettled(scheduledPromises))

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

function waitForAbort(signal: AbortSignal): Promise<'aborted'> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve('aborted')
      return
    }
    signal.addEventListener(
      'abort',
      () => {
        resolve('aborted')
      },
      { once: true }
    )
  })
}
