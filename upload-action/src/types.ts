/**
 * TypeScript type definitions for the Filecoin Upload Action
 */

import type { CopyResult, FailedAttempt } from '@filoz/synapse-sdk'
import type { PaymentStatus as FilecoinPinPaymentStatus } from 'filecoin-pin/core/payments'
import type { initializeSynapse } from 'filecoin-pin/core/synapse'
import type { Logger as PinoLogger } from 'pino'
export type { FilecoinPinPaymentStatus }
export type Synapse = Awaited<ReturnType<typeof initializeSynapse>>

export type Logger = PinoLogger

// Base result types
export interface UploadResult {
  pieceCid: string
  /** Primary copy piece ID (for backwards compatibility) */
  pieceId: string
  /** Primary copy data set ID (for backwards compatibility) */
  dataSetId: string
  provider: {
    id?: string
    name?: string
  }
  previewUrl: string
  network: string
  ipniValidated: boolean
  requestedCopies: number
  complete: boolean
  copies: CopyResult[]
  failedAttempts: FailedAttempt[]
}

export interface BuildResult {
  contentPath: string
  carPath: string
  ipfsRootCid: string
  carSize?: number | undefined
}

// Combined context extends both result types
export interface CombinedContext extends Partial<UploadResult>, Partial<BuildResult> {
  carFilename?: string
  carDownloadUrl?: string
  artifactName?: string
  buildRunId?: string
  eventName?: string
  pr?: Partial<PRMetadata>
  uploadStatus?: string
  runId?: string
  repository?: string
  mode?: string
  phase?: string
  artifactCarPath?: string
  walletPrivateKey?: string
  minStorageDays?: number
  filecoinPayBalanceLimit?: bigint
  withCDN?: boolean
  providerIds?: bigint[]
  paymentStatus?: PaymentStatus
  dryRun?: boolean
}

export interface PaymentStatus
  extends Omit<FilecoinPinPaymentStatus, 'walletUsdfcBalance' | 'filecoinPayBalance' | 'chainId'> {
  filecoinPayBalance: string
  walletUsdfcBalance: string
  storageRunway: string
  depositedThisRun: string
}

export interface SimplifiedPaymentStatus {
  filecoinPayBalance: string
  walletUsdfcBalance: string
  storageRunway: string
  depositedThisRun: string
}

// Configuration types
export interface PRMetadata {
  number: number
  sha: string
  title: string
  author: string
}

export interface PaymentConfig {
  minStorageDays: number
  filecoinPayBalanceLimit?: bigint | undefined
  pieceSizeBytes?: number | undefined
}

export interface PaymentFundingConfig extends PaymentConfig {
  withCDN: boolean
  providerIds?: bigint[] | undefined
}

export interface UploadConfig {
  withCDN: boolean
  providerIds?: bigint[] | undefined
}

export interface ParsedInputs extends PaymentConfig, UploadConfig {
  walletPrivateKey?: string
  contentPath: string
  network: 'mainnet' | 'calibration'
  dryRun: boolean
}

export interface ArtifactUploadOptions {
  retentionDays?: number
  compressionLevel?: number
}

export interface ArtifactDownloadOptions {
  path: string
}

export interface CheckContext {
  octokit: import('@octokit/rest').Octokit
  owner: string
  repo: string
  sha: string
  checkRunId: number | null
}
