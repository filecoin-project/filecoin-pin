import type { ProviderInfo } from '@filoz/synapse-sdk'
import type { CLIAuthOptions } from '../utils/cli-auth.js'

export interface AddOptions extends CLIAuthOptions {
  filePath: string
  bare?: boolean
  /** ID of the existing dataset to use */
  datasetId?: number
  /** Create a new dataset instead of using an existing one */
  createNewDataset?: boolean
  /** Auto-fund: automatically ensure minimum 30 days of runway */
  autoFund?: boolean
  /** Piece metadata attached to each upload */
  pieceMetadata?: Record<string, string>
  /** Data set metadata applied when creating or updating the storage context */
  dataSetMetadata?: Record<string, string>
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
