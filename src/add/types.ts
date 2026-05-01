import type { CopyResult, FailedAttempt } from '@filoz/synapse-sdk'
import type { CLIAuthOptions } from '../utils/cli-auth.js'

export interface AddOptions extends CLIAuthOptions {
  filePath: string
  bare?: boolean
  /** Auto-fund: automatically ensure minimum runway (default 30 days) before upload */
  autoFund?: boolean
  /** Override the minimum runway (in days) targeted by auto-fund */
  minRunwayDays?: number
  /** Cap on Filecoin Pay balance after deposit, in USDFC base units */
  maxBalance?: bigint
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
