import type { Synapse } from '@filoz/synapse-sdk'

// Re-export payment types from the synapse module
export type { PaymentStatus, StorageAllowances } from '../synapse/payments.js'

export interface PaymentSetupOptions {
  auto: boolean
  privateKey?: string
  rpcUrl?: string
  deposit: string
  rateAllowance: string
}

export interface AutoFundOptions {
  /** Synapse instance (required) */
  synapse: Synapse
  /** Size of file being uploaded (in bytes) - used to calculate additional funding needed */
  fileSize: number
  /** Optional spinner for progress updates */
  spinner?: ReturnType<typeof import('../utils/cli-helpers.js').createSpinner>
}

export interface FundingAdjustmentResult {
  /** Whether any adjustment was performed */
  adjusted: boolean
  /** Amount deposited (positive) or withdrawn (negative) */
  delta: bigint
  /** Approval transaction hash (if deposit required approval) */
  approvalTx?: string | undefined
  /** Deposit or withdraw transaction hash */
  transactionHash?: string | undefined
  /** Updated deposited amount after adjustment */
  newDepositedAmount: bigint
  /** New runway in days */
  newRunwayDays: number
  /** New runway hours (fractional part) */
  newRunwayHours: number
}
