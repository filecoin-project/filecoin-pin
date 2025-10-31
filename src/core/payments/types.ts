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
 * Top-up reason codes for programmatic handling
 */
export type TopUpReasonCode =
  | 'none' // No top-up required
  | 'piece-upload' // Insufficient lockup for file upload
  | 'required-runway' // Insufficient balance for minimum storage duration
  | 'required-runway-plus-upload' // Insufficient balance for duration + new upload

/**
 * Calculate required top-up for specific storage scenario
 */
export interface TopUpCalculation {
  requiredTopUp: bigint
  reasonCode: TopUpReasonCode
  calculation: {
    minStorageDays?: number | undefined
    pieceSizeBytes?: number | undefined
    currentRateUsed: bigint
    currentLockupUsed: bigint
    currentDeposited: bigint
    pricePerTiBPerEpoch?: bigint | undefined
  }
}

/**
 * Execute top-up with balance limit checking
 */
export interface TopUpResult {
  success: boolean
  deposited: bigint
  transactionHash?: string
  message: string
  warnings: string[]
}
