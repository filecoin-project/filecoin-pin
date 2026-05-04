import type { CopyResult, FailedAttempt } from '@filoz/synapse-sdk'
import type { CLIAuthOptions } from '../utils/cli-auth.js'
import type { CLIAutoFundOptions } from '../utils/cli-options.js'

export interface AddOptions extends CLIAuthOptions, CLIAutoFundOptions {
  filePath: string
  bare?: boolean
  /** Number of storage copies to create */
  copies?: number
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
  failedAttempts: FailedAttempt[]
}
