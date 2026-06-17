import { getActivePieces } from '@filoz/synapse-core/pdp-verifier'
import { getSizeFromPieceCID } from '@filoz/synapse-core/piece'
import type { Synapse } from '@filoz/synapse-sdk'
import type { DataSetSummary } from './types.js'

const ACTIVE_PIECES_BATCH_SIZE = 100n

export interface DataSetListRow extends Omit<DataSetSummary, 'totalSizeBytes'> {
  totalSizeBytes?: bigint
  sizeKnown: boolean
}

function getActivePieceCount(dataSet: DataSetSummary): bigint {
  return dataSet.activePieceCount ?? 0n
}

async function calculateActivePieceSize(
  synapse: Synapse,
  dataSetId: bigint
): Promise<{
  sizeKnown: boolean
  totalSizeBytes: bigint
}> {
  let offset = 0n
  let hasMore = true
  let totalSizeBytes = 0n
  let sizeKnown = true

  while (hasMore) {
    const result = await getActivePieces(synapse.client, {
      dataSetId,
      offset,
      limit: ACTIVE_PIECES_BATCH_SIZE,
    })

    for (const piece of result.pieces) {
      try {
        totalSizeBytes += BigInt(getSizeFromPieceCID(piece.cid))
      } catch {
        sizeKnown = false
      }
    }

    hasMore = result.hasMore
    offset += ACTIVE_PIECES_BATCH_SIZE
  }

  return { sizeKnown, totalSizeBytes }
}

export async function enrichDataSetListSizes(synapse: Synapse, dataSets: DataSetSummary[]): Promise<DataSetListRow[]> {
  const rows: DataSetListRow[] = []

  for (const dataSet of dataSets) {
    if (!dataSet.isLive || getActivePieceCount(dataSet) === 0n) {
      rows.push({
        ...dataSet,
        totalSizeBytes: 0n,
        sizeKnown: true,
      })
      continue
    }

    const { sizeKnown, totalSizeBytes } = await calculateActivePieceSize(synapse, dataSet.dataSetId)
    const row: DataSetListRow = {
      ...dataSet,
      sizeKnown,
    }
    if (sizeKnown) {
      row.totalSizeBytes = totalSizeBytes
    }
    rows.push(row)
  }

  return rows
}
