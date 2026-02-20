/**
 * Get Detailed Data Set
 *
 * Retrieves a single dataset with full details using direct O(1) lookup.
 *
 * @module core/data-set/get-detailed-data-set
 */

import type { Synapse } from '@filoz/synapse-sdk'
import { WarmStorageService } from '@filoz/synapse-sdk'
import { SPRegistryService } from '@filoz/synapse-sdk/sp-registry'
import { DEFAULT_DATA_SET_METADATA } from '../synapse/constants.js'
import { getDataSetPieces } from './get-data-set-pieces.js'
import type { DataSetSummary, ListDataSetsOptions } from './types.js'

export async function getDetailedDataSet(
  synapse: Synapse,
  dataSetId: number,
  options?: ListDataSetsOptions
): Promise<DataSetSummary> {
  const logger = options?.logger
  const withProviderDetails = options?.withProviderDetails ?? true

  try {
    const warmStorageService = await WarmStorageService.create(synapse.getProvider(), synapse.getWarmStorageAddress())

    const dataSetInfo = await warmStorageService.getDataSet(dataSetId)

    // Fetch metadata and provider info in parallel
    const metadataPromise = warmStorageService.getDataSetMetadata(dataSetId)
    const providerInfoPromise = withProviderDetails
      ? (async () => {
          const registryAddress = warmStorageService.getServiceProviderRegistryAddress()
          const spRegistry = new SPRegistryService(synapse.getProvider(), registryAddress)
          return spRegistry.getProvider(dataSetInfo.providerId)
        })()
      : Promise.resolve(undefined)

    const [metadata, provider] = await Promise.all([metadataPromise, providerInfoPromise])

    const createdWithFilecoinPin = Object.entries(DEFAULT_DATA_SET_METADATA).every(
      ([key, value]) => metadata[key] === value
    )

    if (provider == null) {
      throw new Error(`Provider info is required to create StorageContext for dataset ${dataSetId}`)
    }
    const { StorageContext } = await import('@filoz/synapse-sdk')
    const withCDN = dataSetInfo.cdnRailId > 0
    // @ts-expect-error - Accessing private _warmStorageService temporarily
    const warmStorage = synapse.storage._warmStorageService ?? warmStorageService
    const storageContext = new StorageContext(synapse, warmStorage, provider, dataSetId, { withCDN }, metadata)

    const piecesResult = await getDataSetPieces(synapse, storageContext, {
      includeMetadata: true,
      logger,
    })

    const result: DataSetSummary = {
      ...dataSetInfo,
      pdpVerifierDataSetId: Number(dataSetInfo.dataSetId),
      dataSetId: Number(dataSetInfo.dataSetId),
      nextPieceId: piecesResult.pieces.length,
      currentPieceCount: piecesResult.pieces.length,
      isLive: true,
      isManaged: true,
      withCDN,
      metadata,
      provider: provider ?? undefined,
      pieces: piecesResult.pieces,
      createdWithFilecoinPin,
    }

    if (piecesResult.totalSizeBytes != null) {
      result.totalSizeBytes = piecesResult.totalSizeBytes
    }

    return result
  } catch (error) {
    logger?.error({ dataSetId, error }, `Failed to get detailed data set ${dataSetId}`)
    throw error
  }
}
