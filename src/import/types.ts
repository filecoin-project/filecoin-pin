import type { CopyResult, FailedAttempt } from '@filoz/synapse-sdk'
import type { CLIAuthOptions } from '../utils/cli-auth.js'
import type { CLIAutoFundOptions } from '../utils/cli-options.js'

export interface ImportOptions extends CLIAuthOptions, CLIAutoFundOptions {
  filePath: string
  /** Number of storage copies to create */
  copies?: number
  /** Piece metadata attached to the imported CAR */
  pieceMetadata?: Record<string, string>
  /** Data set metadata applied when creating or updating the storage context */
  dataSetMetadata?: Record<string, string>
  /** Skip IPNI advertisement verification after upload */
  skipIpniVerification?: boolean
  /** Enable FilBeam (CDN) routing — true when --egress-provider beam is active */
  withCDN?: boolean
  /** Where withCDN was resolved from; controls the notice "(default)" suffix */
  withCDNSource?: 'cli' | 'default'
}

export interface ImportResult {
  filePath: string
  fileSize: number
  rootCid: string
  pieceCid: string
  size: number
  requestedCopies: number
  copies: CopyResult[]
  failedAttempts: FailedAttempt[]
}
