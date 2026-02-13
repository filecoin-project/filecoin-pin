/**
 * List Data Sets
 *
 * Functions for listing and summarizing datasets with optional provider enrichment.
 *
 * @module core/data-set/list-data-sets
 */

import type { PDPProvider, Synapse } from '@filoz/synapse-sdk'
import { SPRegistryService } from '@filoz/synapse-sdk/sp-registry'
import type { Hex } from 'viem'
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
 *   console.log(`Dataset ${ds.dataSetId}: ${ds.activePieceCount} pieces`)
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
  const address = (options?.address ?? synapse.client.account.address) as Hex
  const withProviderDetails = options?.withProviderDetails ?? false
  const filter = options?.filter

  // Step 1: Find data sets
  const dataSets = await synapse.storage.findDataSets({ address })

  const filteredDataSets = filter ? dataSets.filter(filter) : dataSets

  // Step 2: Collect unique provider IDs from data sets
  const uniqueProviderIds = withProviderDetails ? Array.from(new Set(filteredDataSets.map((ds) => ds.providerId))) : []

  // Step 3: Fetch provider info for the specific provider IDs using sp-registry
  let providerMap: Map<bigint, PDPProvider> = new Map()
  if (uniqueProviderIds.length > 0) {
    try {
      const spRegistry = new SPRegistryService({ client: synapse.client })
      const providers = await spRegistry.getProviders({ providerIds: uniqueProviderIds })
      providerMap = new Map(providers.map((provider) => [provider.id, provider]))
    } catch (error) {
      logger?.warn({ error }, 'Failed to fetch provider info from sp-registry for provider enrichment')
    }
  }

  // Map SDK datasets to our summary format (spread all fields, add dataSetId alias, provider, and filecoin-pin creation flag)
  return filteredDataSets.map((ds) => {
    // Check if this dataset was created by filecoin-pin by looking for our DEFAULT_DATA_SET_METADATA fields
    const createdWithFilecoinPin = Object.entries(DEFAULT_DATA_SET_METADATA).every(
      ([key, value]) => ds.metadata[key] === value
    )

    const summary: DataSetSummary = {
      ...ds,
      dataSetId: ds.pdpVerifierDataSetId,
      provider: providerMap.get(ds.providerId),
      createdWithFilecoinPin,
    } as DataSetSummary
    return summary
  })
}
