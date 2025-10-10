/**
 * TypeScript type definitions for the Filecoin Upload Action
 */
import type { PaymentStatus as FilecoinPinPaymentStatus } from 'filecoin-pin/core/payments'
import type { SynapseService } from 'filecoin-pin/core/synapse'

export type { FilecoinPinPaymentStatus }
export type Synapse = SynapseService['synapse']

// Base result types
export interface UploadResult {
  pieceCid: string
  pieceId: string
  dataSetId: string
  provider: {
    id?: string
    name?: string
    address?: string
  }
  previewUrl: string
  network: string
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
  providerAddress?: string
  paymentStatus?: PaymentStatus
  dryRun?: boolean
}

export interface PaymentStatus extends Omit<FilecoinPinPaymentStatus, 'depositedAmount'> {
  depositedAmount: string
  currentBalance: string
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
}

export interface UploadConfig {
  withCDN: boolean
  providerAddress: string
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
