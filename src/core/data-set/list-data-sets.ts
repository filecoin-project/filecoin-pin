/**
 * List Data Sets
 *
 * Functions for listing and summarizing datasets.
 *
 * @module core/data-set/list-data-sets
 */

import { paginate } from '@filoz/synapse-core'
import { getPdpDataSets } from '@filoz/synapse-core/warm-storage'
import type { Synapse } from '@filoz/synapse-sdk'
import { DEFAULT_DATA_SET_METADATA } from '../synapse/constants.js'
import { getClientAddress } from '../synapse/index.js'
import type { DataSetSummary, ListDataSetsOptions } from './types.js'

/**
 * List all datasets for an address
 *
 * Fetches data set IDs page by page and enriches them in batches via
 * `getPdpDataSets()`, rather than the one-RPC-call-per-data-set fan-out that
 * `synapse.storage.findDataSets()` does internally. That fan-out times out
 * for accounts with thousands of data sets (see filecoin-project/filecoin-pin#362).
 *
 * Reads latest state rather than a block snapshot, so a data set deleted mid-listing
 * can be omitted.
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
  const logger = options?.logger

  const dataSets: DataSetSummary[] = []
  let processed = 0

  try {
    const pages = paginate(({ cursor }) => getPdpDataSets(synapse.client, { address, cursor }))
    for await (const pdpDataSet of pages) {
      processed++
      const { live, managed, cdn, ...rest } = pdpDataSet
      const createdWithFilecoinPin = Object.entries(DEFAULT_DATA_SET_METADATA).every(
        ([key, value]) => pdpDataSet.metadata[key] === value
      )

      const summary: DataSetSummary = {
        ...rest,
        pdpVerifierDataSetId: pdpDataSet.dataSetId,
        isLive: live,
        isManaged: managed,
        withCDN: cdn,
        // Preserve findDataSets()'s semantics: pieces on a dead data set aren't active.
        hasActivePieces: live && pdpDataSet.hasActivePieces,
        provider: pdpDataSet.provider,
        createdWithFilecoinPin,
      }

      if (filter == null || filter(summary)) {
        dataSets.push(summary)
      }
    }
  } catch (error) {
    // Pino's default error serializer uses `err`.
    logger?.error({ address, dataSetsProcessed: processed, err: error }, `Failed to list data sets for ${address}`)
    throw error
  }

  return dataSets
}
