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
  options?: ListDataSetsOptions
): Promise<DataSetSummary> {
  const logger = options?.logger
  const withProviderDetails = options?.withProviderDetails ?? true

  try {
    const [storageContext, pdpDataSet] = await Promise.all([
      synapse.storage.createContext({ dataSetId }),
      getPdpDataSet(synapse.client, { dataSetId }),
    ])

    if (pdpDataSet == null) {
      throw new Error(`Data set ${dataSetId} not found`)
    }

    const piecesResult = await getDataSetPieces(synapse, storageContext, {
      includeMetadata: true,
      logger,
    })

    const createdWithFilecoinPin = Object.entries(DEFAULT_DATA_SET_METADATA).every(
      ([key, value]) => pdpDataSet.metadata[key] === value
    )

    const result: DataSetSummary = {
      pdpRailId: pdpDataSet.pdpRailId,
      cacheMissRailId: pdpDataSet.cacheMissRailId,
      cdnRailId: pdpDataSet.cdnRailId,
      payer: pdpDataSet.payer,
      payee: pdpDataSet.payee,
      serviceProvider: pdpDataSet.serviceProvider,
      commissionBps: pdpDataSet.commissionBps,
      clientDataSetId: pdpDataSet.clientDataSetId,
      pdpEndEpoch: pdpDataSet.pdpEndEpoch,
      providerId: pdpDataSet.providerId,
      dataSetId,
      pdpVerifierDataSetId: dataSetId,
      activePieceCount: pdpDataSet.activePieceCount,
      isLive: pdpDataSet.live,
      isManaged: pdpDataSet.managed,
      withCDN: pdpDataSet.cdn,
      metadata: pdpDataSet.metadata,
      provider: withProviderDetails ? pdpDataSet.provider : undefined,
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
