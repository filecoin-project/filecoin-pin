/**
 * List Data Sets
 *
 * Functions for listing and summarizing datasets with optional provider enrichment.
 *
 * @module core/data-set/list-data-sets
 */

import type { ProviderInfo, Synapse } from '@filoz/synapse-sdk'
import { DEFAULT_DATA_SET_METADATA } from '../synapse/constants.js'
import type { DataSetSummary, ListDataSetsOptions } from './types.js'

/**
 * List all datasets for an address with optional provider enrichment
 *
 * Example usage:
 * ```typescript
 * const synapse = await Synapse.create({ privateKey, rpcURL })
 * const datasets = await listDataSets(synapse)
 *
 * for (const ds of datasets) {
 *   console.log(`Dataset ${ds.dataSetId}: ${ds.currentPieceCount} pieces`)
 *   if (ds.provider) {
 *     console.log(`  Provider: ${ds.provider.name}`)
 *   }
 * }
 * ```
 *
 * @param synapse - Initialized Synapse instance
 * @param options - Optional configuration
 * @returns Array of dataset summaries
 */
export async function listDataSets(synapse: Synapse, options?: ListDataSetsOptions): Promise<DataSetSummary[]> {
  const logger = options?.logger
  const address = options?.address ?? (await synapse.getClient().getAddress())

  // Fetch datasets and provider info in parallel
  const [dataSets, storageInfo] = await Promise.all([
    synapse.storage.findDataSets(address),
    synapse.storage.getStorageInfo().catch((error) => {
      logger?.warn({ error }, 'Failed to fetch storage info for provider enrichment')
      return null
    }),
  ])

  // Build provider lookup map for provider enrichment
  const providerMap: Map<number, ProviderInfo> = new Map(
    storageInfo?.providers?.map((provider) => [provider.id, provider] as const) ?? []
  )

  // Map SDK datasets to our summary format (spread all fields, add dataSetId alias, provider, and filecoin-pin creation flag)
  return dataSets.map((ds) => {
    // Check if this dataset was created by filecoin-pin by looking for our DEFAULT_DATA_SET_METADATA fields
    const createdWithFilecoinPin = Object.entries(DEFAULT_DATA_SET_METADATA).every(
      ([key, value]) => ds.metadata[key] === value
    )

    const summary: DataSetSummary = {
      ...ds,
      dataSetId: ds.pdpVerifierDataSetId,
      provider: providerMap.get(ds.providerId),
      createdWithFilecoinPin,
    }
    return summary
  })
}
