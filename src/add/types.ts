import type { ProviderInfo } from '@filoz/synapse-sdk'
import type { CLIAuthOptions } from '../utils/cli-auth.js'

export interface AddOptions extends CLIAuthOptions {
  filePath: string
  bare?: boolean
  /** Auto-fund: automatically ensure minimum 10 days of runway */
  autoFund?: boolean
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
