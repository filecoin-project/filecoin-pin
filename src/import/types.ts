import type { ProviderInfo } from '@filoz/synapse-sdk'
import type { CLIAuthOptions } from '../utils/cli-auth.js'

export interface ImportOptions extends CLIAuthOptions {
  filePath: string
  /** Auto-fund: automatically ensure minimum 30 days of runway */
  autoFund?: boolean
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
