/**
 * List Data Sets
 *
 * Functions for listing and summarizing datasets with optional provider enrichment.
 *
 * @module core/data-set/list-data-sets
 */

import type { ProviderInfo, Synapse } from '@filoz/synapse-sdk'
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

  // Map SDK datasets to our summary format (spread all fields, add dataSetId alias and provider)
  return dataSets.map((ds) => {
    const summary: DataSetSummary = {
      ...ds,
      dataSetId: ds.pdpVerifierDataSetId,
      provider: providerMap.get(ds.providerId),
    }
    return summary
  })
}
