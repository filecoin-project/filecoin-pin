import type { ProviderInfo } from '@filoz/synapse-sdk'

export interface AddOptions {
  filePath: string
  privateKey?: string
  rpcUrl?: string
  bare?: boolean
}

export interface AddResult {
  filePath: string
  fileSize: number
  isDirectory?: boolean
  rootCid: string
  pieceCid: string
  pieceId?: number | undefined
  dataSetId: string
  transactionHash?: string | undefined
  providerInfo: ProviderInfo
}
