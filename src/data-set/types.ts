import type { EnhancedDataSetInfo, ProviderInfo } from '@filoz/synapse-sdk'

export interface PieceDetail {
  pieceId: number
  pieceCid: string
  metadata: Record<string, string>
}

export interface DataSetDetail {
  base: EnhancedDataSetInfo
  provider?: ProviderInfo
  leafCount?: bigint
  totalSizeBytes?: bigint
  metadata: Record<string, string>
  pieces: PieceDetail[]
  warnings: string[]
}

export interface DataSetInspectionContext {
  address: string
  network: string
  dataSets: DataSetDetail[]
}

export interface DataSetCommandOptions {
  ls?: boolean
  privateKey?: string
  rpcUrl?: string
}
