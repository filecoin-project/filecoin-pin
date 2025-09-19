import type { ProviderInfo } from '@filoz/synapse-sdk'

export interface ImportOptions {
  filePath: string
  privateKey?: string
  rpcUrl?: string
}

export interface ImportResult {
  filePath: string
  fileSize: number
  rootCid: string
  pieceCid: string
  pieceId?: number | undefined
  dataSetId: string
  transactionHash?: string | undefined
  providerInfo: ProviderInfo
}
