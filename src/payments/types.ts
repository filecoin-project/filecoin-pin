import type { Synapse } from '@filoz/synapse-sdk'
import type { Spinner } from '../utils/cli-helpers.js'

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
  spinner?: Spinner
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

export type FundMode = 'exact' | 'minimum'

export interface FundOptions {
  privateKey?: string
  rpcUrl?: string
  days?: number
  amount?: string
  /**
   * Mode to use for funding (default: exact)
   *
   *
   * exact: Adjust funds to exactly match a target runway (days) or a target deposited amount.
   * minimum: Adjust funds to match a minimum runway (days) or a minimum deposited amount.
   */
  mode?: FundMode
}
