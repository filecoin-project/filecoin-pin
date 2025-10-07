/**
 * TypeScript type definitions for the Filecoin Upload Action
 */
import type { PaymentStatus as FilecoinPinPaymentStatus } from 'filecoin-pin/synapse/payments.js'

export type { PaymentStatus as FilecoinPinPaymentStatus } from 'filecoin-pin/synapse/payments.js'

export interface CombinedContext {
  ipfsRootCid?: string
  carPath?: string
  carFilename?: string
  carDownloadUrl?: string
  carSize?: number | undefined
  artifactName?: string
  buildRunId?: string
  eventName?: string
  pr?: {
    number?: number
    sha?: string
    title?: string
    author?: string
  }
  pieceCid?: string
  pieceId?: string
  dataSetId?: string
  provider?: {
    id?: string
    name?: string
  }
  uploadStatus?: string
  runId?: string
  repository?: string
  mode?: string
  phase?: string
  network?: string
  artifactCarPath?: string
  contentPath?: string
  walletPrivateKey?: string
  minStorageDays?: number
  filecoinPayBalanceLimit?: bigint
  withCDN?: boolean
  providerAddress?: string
  previewUrl?: string
  paymentStatus?: PaymentStatus
  dryRun?: boolean
}

export interface PaymentStatus extends Omit<FilecoinPinPaymentStatus, 'depositedAmount'> {
  depositedAmount: string
  currentBalance: string
  storageRunway: string
  depositedThisRun: string
}

export interface ParsedInputs {
  walletPrivateKey?: string
  contentPath: string
  network: 'mainnet' | 'calibration'
  minStorageDays: number
  filecoinPayBalanceLimit?: bigint | undefined
  withCDN: boolean
  providerAddress: string
  dryRun: boolean
}

export interface PRMetadata {
  number: number
  sha: string
  title: string
  author: string
}

export interface UploadResult {
  pieceCid: string
  pieceId: string
  dataSetId: string
  provider: {
    id?: string
    name?: string
  }
  previewURL: string
  network: string
}

export interface BuildResult {
  contentPath: string
  carPath: string
  ipfsRootCid: string
  carSize?: number | undefined
}

export interface CommentPRParams {
  ipfsRootCid: string
  dataSetId: string
  pieceCid: string
  uploadStatus: string
  /**
   * The piece CID preview URL, directly from the provider
   */
  previewUrl?: string | undefined
  prNumber?: number
  githubToken: string
  githubRepository: string
  network?: string | undefined
}

export interface PaymentConfig {
  minStorageDays: number
  filecoinPayBalanceLimit?: bigint | undefined
}

export interface UploadConfig {
  withCDN: boolean
  providerAddress: string
}

export interface ArtifactUploadOptions {
  retentionDays?: number
  compressionLevel?: number
}

export interface ArtifactDownloadOptions {
  path: string
}
