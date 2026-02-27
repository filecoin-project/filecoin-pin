/**
 * List Data Sets
 *
 * Functions for listing and summarizing datasets with optional provider enrichment.
 *
 * @module core/data-set/list-data-sets
 */

import type { PDPProvider, Synapse } from '@filoz/synapse-sdk'
import { DEFAULT_DATA_SET_METADATA } from '../synapse/constants.js'
import { getClientAddress } from '../synapse/index.js'
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
  const address = options?.address ?? getClientAddress(synapse)
  const withProviderDetails = options?.withProviderDetails ?? false
  const filter = options?.filter

  const dataSets = await synapse.storage.findDataSets({ address })

  const filteredDataSets = filter ? dataSets.filter(filter) : dataSets

  // Fetch provider info for unique provider IDs
  let providerMap: Map<bigint, PDPProvider> = new Map()
  if (withProviderDetails) {
    const uniqueProviderIds = Array.from(new Set(filteredDataSets.map((ds) => ds.providerId)))
    if (uniqueProviderIds.length > 0) {
      try {
        const providers = await synapse.providers.getProviders({ providerIds: uniqueProviderIds })
        providerMap = new Map(providers.map((provider) => [provider.id, provider]))
      } catch (error) {
        logger?.warn({ error }, 'Failed to fetch provider info for provider enrichment')
      }
    }
  }

  return filteredDataSets.map((ds) => {
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
