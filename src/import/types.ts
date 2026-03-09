import type { CopyResult, FailedCopy } from '@filoz/synapse-sdk'
import type { CLIAuthOptions } from '../utils/cli-auth.js'

export interface ImportOptions extends CLIAuthOptions {
  filePath: string
  /** Auto-fund: automatically ensure minimum 30 days of runway */
  autoFund?: boolean
  /** Number of storage copies to create */
  count?: number
  /** Piece metadata attached to the imported CAR */
  pieceMetadata?: Record<string, string>
  /** Data set metadata applied when creating or updating the storage context */
  dataSetMetadata?: Record<string, string>
  /** Skip IPNI advertisement verification after upload */
  skipIpni?: boolean
}

export interface ImportResult {
  filePath: string
  fileSize: number
  rootCid: string
  pieceCid: string
  size: number
  copies: CopyResult[]
  failures: FailedCopy[]
}
