/**
 * List Data Sets
 *
 * Functions for listing and summarizing datasets.
 *
 * @module core/data-set/list-data-sets
 */

import type { Synapse } from '@filoz/synapse-sdk'
import { DEFAULT_DATA_SET_METADATA } from '../synapse/constants.js'
import { getClientAddress } from '../synapse/index.js'
import type { DataSetSummary, ListDataSetsOptions } from './types.js'

/**
 * List all datasets for an address
 *
 * Example usage:
 * ```typescript
 * const synapse = await Synapse.create({ privateKey, rpcURL })
 * const datasets = await listDataSets(synapse)
 *
 * for (const ds of datasets) {
 *   console.log(`Dataset ${ds.dataSetId}: ${ds.currentPieceCount} pieces`)
 * }
 * ```
 *
 * @param synapse - Initialized Synapse instance
 * @param options - Optional configuration
 * @returns Array of dataset summaries
 */
export async function listDataSets(synapse: Synapse, options?: ListDataSetsOptions): Promise<DataSetSummary[]> {
  const address = options?.address ?? getClientAddress(synapse)
  const filter = options?.filter

  const dataSets = await synapse.storage.findDataSets({ address })

  const filteredDataSets = filter ? dataSets.filter(filter) : dataSets

  return filteredDataSets.map((ds) => {
    const createdWithFilecoinPin = Object.entries(DEFAULT_DATA_SET_METADATA).every(
      ([key, value]) => ds.metadata[key] === value
    )

    const summary: DataSetSummary = {
      ...ds,
      dataSetId: ds.pdpVerifierDataSetId,
      provider: undefined,
      createdWithFilecoinPin,
    }
    return summary
  })
}
