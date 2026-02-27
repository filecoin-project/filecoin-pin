/**
 * Get Detailed Data Set
 *
 * Retrieves a single dataset with full details including pieces and provider info.
 *
 * @module core/data-set/get-detailed-data-set
 */

import type { Synapse } from '@filoz/synapse-sdk'
import { DEFAULT_DATA_SET_METADATA } from '../synapse/constants.js'
import { getClientAddress } from '../synapse/index.js'
import { getDataSetPieces } from './get-data-set-pieces.js'
import type { DataSetSummary, ListDataSetsOptions } from './types.js'

export async function getDetailedDataSet(
  synapse: Synapse,
  dataSetId: bigint,
  options?: ListDataSetsOptions
): Promise<DataSetSummary> {
  const logger = options?.logger
  const withProviderDetails = options?.withProviderDetails ?? true

  try {
    // Create a storage context for this specific dataset
    const storageContext = await synapse.storage.createContext({ dataSetId })

    // Get provider info if requested
    const provider = withProviderDetails
      ? await synapse.providers.getProvider({ providerId: storageContext.provider.id })
      : undefined

    const metadata = storageContext.dataSetMetadata

    const createdWithFilecoinPin = Object.entries(DEFAULT_DATA_SET_METADATA).every(
      ([key, value]) => metadata[key] === value
    )

    const piecesResult = await getDataSetPieces(synapse, storageContext, {
      includeMetadata: true,
      logger,
    })

    // Find matching dataset info from findDataSets to get full EnhancedDataSetInfo fields
    const address = getClientAddress(synapse)
    const allDataSets = await synapse.storage.findDataSets({ address })
    const dataSetInfo = allDataSets.find((ds) => ds.pdpVerifierDataSetId === dataSetId)

    if (dataSetInfo == null) {
      throw new Error(`Data set ${dataSetId} not found for address ${address}`)
    }

    const result: DataSetSummary = {
      ...dataSetInfo,
      dataSetId,
      provider: provider ?? undefined,
      pieces: piecesResult.pieces,
      createdWithFilecoinPin,
    }

    if (piecesResult.totalSizeBytes != null) {
      result.totalSizeBytes = piecesResult.totalSizeBytes
    }

    return result
  } catch (error) {
    logger?.error({ dataSetId: dataSetId.toString(), error }, `Failed to get detailed data set ${dataSetId}`)
    throw error
  }
}
