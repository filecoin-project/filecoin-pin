import type { Synapse } from '@filoz/synapse-sdk'
import { getDataSetPieces } from './get-data-set-pieces.js'
import { listDataSets } from './list-data-sets.js'
import type { DataSetSummary, ListDataSetsOptions } from './types.js'

export async function getDetailedDataSet(
  synapse: Synapse,
  dataSetId: number,
  options?: ListDataSetsOptions
): Promise<DataSetSummary> {
  const logger = options?.logger
  const dataSets = await listDataSets(synapse, {
    ...options,
    withProviderDetails: true,
    filter: (dataSet) => dataSet.pdpVerifierDataSetId === dataSetId,
  })

  const dataSet = dataSets[0]
  if (dataSets.length === 0 || dataSet == null) {
    logger?.error({ dataSetId }, `Data set ${dataSetId} not found`)
    throw new Error(`Data set ${dataSetId} not found`)
  }

  const storageContext = await synapse.storage.createContext({
    dataSetId: dataSet.dataSetId,
    providerId: dataSet.providerId,
  })

  const piecesResult = await getDataSetPieces(synapse, storageContext, {
    includeMetadata: true,
    logger,
  })

  const result: DataSetSummary = {
    ...dataSet,
    pieces: piecesResult.pieces,
  }

  if (piecesResult.totalSizeBytes != null) {
    result.totalSizeBytes = piecesResult.totalSizeBytes
  }

  return result
}
