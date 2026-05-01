import type { Synapse } from '@filoz/synapse-sdk'
import type { FundingMode } from '../core/payments/types.js'
import type { CLIAuthOptions } from '../utils/cli-auth.js'
import type { Spinner } from '../utils/cli-helpers.js'

// Re-export payment types from the core module
export type {
  FilecoinPayFundingExecution,
  FilecoinPayFundingPlan,
  FundingMode,
  PaymentStatus,
  StorageAllowances,
} from '../core/payments/index.js'

export interface PaymentSetupOptions extends CLIAuthOptions {
  auto: boolean
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
  /** Minimum runway to maintain, in days. Defaults to MIN_RUNWAY_DAYS. */
  minRunwayDays?: number
  /** Maximum Filecoin Pay balance after deposit (USDFC base units). Skips or clamps over-projected deposits. */
  maxBalance?: bigint
}

export interface FundingAdjustmentResult {
  /** Whether any adjustment was performed */
  adjusted: boolean
  /** Amount deposited (positive) or withdrawn (negative) */
  delta: bigint
  /** Deposit or withdraw transaction hash */
  transactionHash?: string | undefined
  /** Updated deposited amount after adjustment */
  newDepositedAmount: bigint
  /** New runway in days */
  newRunwayDays: number
  /** New runway hours (fractional part) */
  newRunwayHours: number
  /** Notices about deviations from the requested plan (e.g. clamped or skipped due to maxBalance) */
  warnings?: string[]
}

export interface FundOptions extends CLIAuthOptions {
  days?: number
  amount?: string
  /**
   * Mode to use for funding (default: exact)
   *
   *
   * exact: Adjust funds to exactly match a target runway (days) or a target deposited amount.
   * minimum: Adjust funds to match a minimum runway (days) or a minimum deposited amount.
   */
  mode?: FundingMode
}
