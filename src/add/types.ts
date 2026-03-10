import type { CopyResult, FailedCopy } from '@filoz/synapse-sdk'
import type { CLIAuthOptions } from '../utils/cli-auth.js'

export interface AddOptions extends CLIAuthOptions {
  filePath: string
  bare?: boolean
  /** Auto-fund: automatically ensure minimum 30 days of runway */
  autoFund?: boolean
  /** Number of storage copies to create */
  count?: number
  /** Piece metadata attached to each upload */
  pieceMetadata?: Record<string, string>
  /** Data set metadata applied when creating or updating the storage context */
  dataSetMetadata?: Record<string, string>
  /** Skip IPNI advertisement verification after upload */
  skipIpniVerification?: boolean
}

export interface AddResult {
  filePath: string
  fileSize: number
  isDirectory?: boolean
  rootCid: string
  pieceCid: string
  size: number
  copies: CopyResult[]
  failures: FailedCopy[]
}
