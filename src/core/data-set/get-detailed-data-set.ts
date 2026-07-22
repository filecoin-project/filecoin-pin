/**
 * Get Detailed Data Set
 *
 * Retrieves a single dataset with full details including pieces and provider info.
 *
 * @module core/data-set/get-detailed-data-set
 */

import { getPdpDataSet } from '@filoz/synapse-core/warm-storage'
import type { Synapse } from '@filoz/synapse-sdk'
import { DEFAULT_DATA_SET_METADATA } from '../synapse/constants.js'
import { getDataSetPieces } from './get-data-set-pieces.js'
import type { DataSetSummary, ListDataSetsOptions } from './types.js'

export async function getDetailedDataSet(
  synapse: Synapse,
  dataSetId: bigint,
  options?: ListDataSetsOptions & { includePieces?: boolean }
): Promise<DataSetSummary> {
  const logger = options?.logger
  const includePieces = options?.includePieces ?? true

  try {
    const pdpDataSet = await getPdpDataSet(synapse.client, { dataSetId })

    if (pdpDataSet == null) {
      throw new Error(`Data set ${dataSetId} not found`)
    }

    const createdWithFilecoinPin = Object.entries(DEFAULT_DATA_SET_METADATA).every(
      ([key, value]) => pdpDataSet.metadata[key] === value
    )

    const result: DataSetSummary = {
      ...pdpDataSet,
      pdpVerifierDataSetId: dataSetId,
      dataSetId,
      isLive: pdpDataSet.live,
      isManaged: pdpDataSet.managed,
      withCDN: pdpDataSet.cdn,
      provider: pdpDataSet.provider,
      createdWithFilecoinPin,
    }

    if (!includePieces) {
      return result
    }

    const piecesResult = await getDataSetPieces(synapse, dataSetId, pdpDataSet.provider.pdp?.serviceURL ?? '', {
      includeMetadata: true,
      logger,
    })

    result.pieces = piecesResult.pieces
    if (piecesResult.totalSizeBytes != null) {
      result.totalSizeBytes = piecesResult.totalSizeBytes
    }

    return result
  } catch (error) {
    logger?.error({ dataSetId: dataSetId.toString(), error }, `Failed to get detailed data set ${dataSetId}`)
    throw error
  }
}
