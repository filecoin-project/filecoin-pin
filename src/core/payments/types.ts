/**
 * Service approval status from the Payments contract
 */
export interface ServiceApprovalStatus {
  rateAllowance: bigint
  lockupAllowance: bigint
  lockupUsed: bigint
  maxLockupPeriod: bigint
  rateUsed: bigint
}

/**
 * Complete payment status including balances and approvals
 */
export interface PaymentStatus {
  network: string
  address: string
  filBalance: bigint
  /** USDFC tokens sitting in the owner wallet (not yet deposited) */
  walletUsdfcBalance: bigint
  /** USDFC balance currently deposited into Filecoin Pay (WarmStorage contract) */
  filecoinPayBalance: bigint
  currentAllowances: ServiceApprovalStatus
}

/**
 * Storage allowance calculations
 */
export interface StorageAllowances {
  rateAllowance: bigint
  lockupAllowance: bigint
  storageCapacityTiB: number
}

export type StorageRunwayState = 'unknown' | 'no-spend' | 'active'

export interface StorageRunwaySummary {
  state: StorageRunwayState
  available: bigint
  rateUsed: bigint
  perDay: bigint
  lockupUsed: bigint
  days: number
  hours: number
}

export interface PaymentValidationResult {
  isValid: boolean
  errorMessage?: string
  helpMessage?: string
}

/**
 * Funding mode controls how target adjustments are applied
 *
 * - `exact`: Adjust deposit to reach exact target (can deposit or withdraw)
 * - `minimum`: Only deposit if below target, never withdraw
 */
export type FundingMode = 'exact' | 'minimum'

/**
 * Semantic reason codes for funding operations
 */
export type FundingReasonCode =
  | 'none' // No funding adjustment needed
  | 'piece-upload' // Need lockup for new piece upload
  | 'runway-insufficient' // Current runway below target (no piece)
  | 'runway-with-piece' // Runway + piece upload combined
  | 'target-deposit' // Reaching specific deposit amount
  | 'withdrawal-excess' // Over-funded, can withdraw

/**
 * Comprehensive funding insights with runway projections and depletion predictions
 *
 * Provides detailed view of current or projected funding state including:
 * - Spend rates (per epoch and per day)
 * - Available balance after lockup
 * - Runway calculations (days and hours remaining)
 * - Depletion timestamps (when funds will run out)
 */
export interface FilecoinPayFundingInsights {
  spendRatePerEpoch: bigint
  spendRatePerDay: bigint
  depositedBalance: bigint
  availableDeposited: bigint
  walletUsdfcBalance: bigint
  runway: StorageRunwaySummary
  filecoinPayDepletionSeconds?: bigint | null
  filecoinPayDepletionTimestampMs?: number | null
  ownerDepletionSeconds?: bigint | null
  ownerDepletionTimestampMs?: number | null
}

/**
 * Options for calculating a Filecoin Pay funding plan
 *
 * Used by `calculateFilecoinPayFundingPlan` - the pure calculation function.
 * Requires an existing `PaymentStatus` object (no network calls made).
 *
 * Specify either `targetRunwayDays` OR `targetDeposit`, not both.
 */
export interface FilecoinPayFundingPlanOptions {
  status: PaymentStatus
  targetRunwayDays?: number | undefined
  targetDeposit?: bigint | undefined
  pieceSizeBytes?: number | undefined
  pricePerTiBPerEpoch?: bigint | undefined
  mode?: FundingMode | undefined
  allowWithdraw?: boolean | undefined
}

/**
 * A complete funding plan with delta, action, and before/after insights
 *
 * Result of funding calculation containing:
 * - `delta`: Amount to deposit (positive) or withdraw (negative)
 * - `action`: What operation is needed ('deposit', 'withdraw', or 'none')
 * - `reasonCode`: Why this funding adjustment is needed
 * - `current`: Current funding state
 * - `projected`: Projected state after adjustment
 * - `walletShortfall`: If deposit needed but wallet has insufficient USDFC
 */
export interface FilecoinPayFundingPlan {
  targetType: 'runway-days' | 'deposit'
  targetRunwayDays?: number
  targetDeposit?: bigint
  delta: bigint
  action: 'deposit' | 'withdraw' | 'none'
  reasonCode: FundingReasonCode
  mode: FundingMode
  pieceSizeBytes?: number
  pricePerTiBPerEpoch?: bigint
  projectedDeposit: bigint
  projectedRateUsed: bigint
  projectedLockupUsed: bigint
  walletShortfall?: bigint
  current: FilecoinPayFundingInsights
  projected: FilecoinPayFundingInsights
}

/**
 * Result of executing a funding plan
 *
 * Contains actual execution results including:
 * - Whether adjustment was made
 * - Transaction hash if funds were moved
 * - Updated deposit amount and runway after execution
 * - Fresh insights reflecting post-execution state
 */
export interface FilecoinPayFundingExecution {
  adjusted: boolean
  delta: bigint
  transactionHash?: string
  newDepositedAmount: bigint
  newRunwayDays: number
  newRunwayHours: number
  plan: FilecoinPayFundingPlan
  updatedInsights: FilecoinPayFundingInsights
}

/**
 * Payment capacity validation for a specific file
 */
export interface PaymentCapacityCheck {
  canUpload: boolean
  storageTiB: number
  required: StorageAllowances
  issues: {
    insufficientDeposit?: bigint
    insufficientRateAllowance?: bigint
    insufficientLockupAllowance?: bigint
  }
  suggestions: string[]
}

/**
 * Execute top-up with balance limit checking
 *
 * Used by executeTopUp for simple deposit operations with balance limit enforcement.
 * For comprehensive funding operations with before/after insights, use FilecoinPayFundingExecution.
 */
export interface TopUpResult {
  success: boolean
  deposited: bigint
  transactionHash?: string
  message: string
  warnings: string[]
}
