import { SIZE_CONSTANTS, TIME_CONSTANTS, TOKENS, type Synapse } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'

/** Number of decimal places used by USDFC tokens. */
export const USDFC_DECIMALS = 18

/** Default WarmStorage lockup period (days). */
export const DEFAULT_LOCKUP_DAYS = 10

/**
 * Numerator/denominator pair representing the standard 10% buffer applied to
 * lockup requirements (adds a safety margin beyond the mandatory lockup).
 */
export const BUFFER_NUMERATOR = 11n
export const BUFFER_DENOMINATOR = 10n

// Maximum allowances for trusted WarmStorage service.
const MAX_RATE_ALLOWANCE = ethers.MaxUint256
const MAX_LOCKUP_ALLOWANCE = ethers.MaxUint256

/**
 * Maximum integer scaling factor when converting TiB/month to epoch-based
 * allowances. Keeps intermediate math within `Number.MAX_SAFE_INTEGER`.
 */
export const STORAGE_SCALE_MAX = 10_000_000
const STORAGE_SCALE_MAX_BI = BigInt(STORAGE_SCALE_MAX)

export type StorageRunwayState = 'unknown' | 'no-spend' | 'active'

export interface ServiceApprovalStatus {
  rateAllowance: bigint
  lockupAllowance: bigint
  lockupUsed: bigint
  maxLockupPeriod?: bigint
  rateUsed?: bigint
}

export interface PaymentStatus {
  network: string
  address: string
  filBalance: bigint
  usdfcBalance: bigint
  depositedAmount: bigint
  currentAllowances: ServiceApprovalStatus
}

export interface StorageAllowances {
  rateAllowance: bigint
  lockupAllowance: bigint
  storageCapacityTiB: number
}

export interface StorageRunwaySummary {
  state: StorageRunwayState
  available: bigint
  rateUsed: bigint
  perDay: bigint
  lockupUsed: bigint
  days: number
  hours: number
}

/**
 * Result of evaluating whether current payment setup can support an upload.
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
 * Validation result describing whether payment preconditions are satisfied.
 */
export interface PaymentValidationResult {
  isValid: boolean
  errorMessage?: string
  helpMessage?: string
}

/** Apply the standard 10% buffer to a base amount. */
export function withBuffer(amount: bigint): bigint {
  return (amount * BUFFER_NUMERATOR) / BUFFER_DENOMINATOR
}

/** Remove the standard 10% buffer (inverse of {@link withBuffer}). */
export function withoutBuffer(amount: bigint): bigint {
  return (amount * BUFFER_DENOMINATOR) / BUFFER_NUMERATOR
}

/**
 * Compute an adaptive scaling factor that keeps `storageTiB * scale` within
 * `Number.MAX_SAFE_INTEGER` while preserving precision for very small values.
 */
export function getStorageScale(storageTiB: number): number {
  if (storageTiB <= 0) return 1
  const maxScaleBySafe = Math.floor(Number.MAX_SAFE_INTEGER / storageTiB)
  return Math.max(1, Math.min(STORAGE_SCALE_MAX, maxScaleBySafe))
}

/**
 * Convert a human-friendly storage target (TiB/month) into rate/lockup
 * allowances required by WarmStorage.
 */
export function calculateStorageAllowances(storageTiB: number, pricePerTiBPerEpoch: bigint): StorageAllowances {
  const scale = getStorageScale(storageTiB)
  const scaledStorage = Math.floor(storageTiB * scale)
  const rateAllowance = (pricePerTiBPerEpoch * BigInt(scaledStorage)) / BigInt(scale)

  const epochsIn10Days = BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY
  const lockupAllowance = rateAllowance * epochsIn10Days

  return {
    rateAllowance,
    lockupAllowance,
    storageCapacityTiB: storageTiB,
  }
}

/**
 * Inverse of {@link calculateStorageAllowances}: derive TiB/month capacity
 * supported by the provided rate allowance at current pricing.
 */
export function calculateActualCapacity(rateAllowance: bigint, pricePerTiBPerEpoch: bigint): number {
  if (pricePerTiBPerEpoch === 0n) return 0

  const scaledQuotient = (rateAllowance * STORAGE_SCALE_MAX_BI) / pricePerTiBPerEpoch
  if (scaledQuotient > 0n) {
    return Number(scaledQuotient) / STORAGE_SCALE_MAX
  }

  const rateFloat = Number(ethers.formatUnits(rateAllowance, USDFC_DECIMALS))
  const priceFloat = Number(ethers.formatUnits(pricePerTiBPerEpoch, USDFC_DECIMALS))
  if (!Number.isFinite(rateFloat) || !Number.isFinite(priceFloat) || priceFloat === 0) {
    return 0
  }
  return rateFloat / priceFloat
}

/**
 * Determine storage capacity (TiB/month) purchasable with a USDFC amount,
 * accounting for the mandatory 10-day lockup period.
 */
export function calculateStorageFromUSDFC(usdfcAmount: bigint, pricePerTiBPerEpoch: bigint): number {
  if (pricePerTiBPerEpoch === 0n) return 0

  const epochsIn10Days = BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY
  const ratePerEpoch = usdfcAmount / epochsIn10Days

  return calculateActualCapacity(ratePerEpoch, pricePerTiBPerEpoch)
}

/**
 * Compute the additional deposit required to keep current spend alive for the
 * specified number of days.
 */
export function computeTopUpForDuration(
  status: Pick<PaymentStatus, 'depositedAmount' | 'currentAllowances'>,
  days: number
): {
  topUp: bigint
  available: bigint
  rateUsed: bigint
  perDay: bigint
  lockupUsed: bigint
} {
  const rateUsed = status.currentAllowances.rateUsed ?? 0n
  const lockupUsed = status.currentAllowances.lockupUsed ?? 0n

  if (days <= 0) {
    return {
      topUp: 0n,
      available: status.depositedAmount > lockupUsed ? status.depositedAmount - lockupUsed : 0n,
      rateUsed,
      perDay: rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY,
      lockupUsed,
    }
  }

  if (rateUsed === 0n) {
    return {
      topUp: 0n,
      available: status.depositedAmount > lockupUsed ? status.depositedAmount - lockupUsed : 0n,
      rateUsed,
      perDay: 0n,
      lockupUsed,
    }
  }

  const epochsNeeded = BigInt(Math.ceil(days)) * TIME_CONSTANTS.EPOCHS_PER_DAY
  const spendNeeded = rateUsed * epochsNeeded
  const available = status.depositedAmount > lockupUsed ? status.depositedAmount - lockupUsed : 0n

  const topUp = spendNeeded > available ? spendNeeded - available : 0n

  return {
    topUp,
    available,
    rateUsed,
    perDay: rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY,
    lockupUsed,
  }
}

/**
 * Compute deposit delta needed to reach an exact runway in days. Positive delta
 * means deposit, negative means withdraw. Includes an hour safety buffer.
 */
export function computeAdjustmentForExactDays(
  status: Pick<PaymentStatus, 'depositedAmount' | 'currentAllowances'>,
  days: number
): {
  delta: bigint
  targetAvailable: bigint
  available: bigint
  rateUsed: bigint
  perDay: bigint
  lockupUsed: bigint
} {
  const rateUsed = status.currentAllowances.rateUsed ?? 0n
  const lockupUsed = status.currentAllowances.lockupUsed ?? 0n
  const available = status.depositedAmount > lockupUsed ? status.depositedAmount - lockupUsed : 0n
  const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY

  if (days < 0) {
    throw new Error('days must be non-negative')
  }
  if (rateUsed === 0n) {
    return {
      delta: 0n,
      targetAvailable: 0n,
      available,
      rateUsed,
      perDay,
      lockupUsed,
    }
  }

  const perHour = perDay / 24n
  const safety = perHour > 0n ? perHour : 1n
  const targetAvailable = BigInt(Math.floor(days)) * perDay + safety
  const delta = targetAvailable - available

  return {
    delta,
    targetAvailable,
    available,
    rateUsed,
    perDay,
    lockupUsed,
  }
}

/**
 * Compute deposit delta needed to reach an exact total deposit while never
 * withdrawing below the currently locked amount.
 */
export function computeAdjustmentForExactDeposit(
  status: Pick<PaymentStatus, 'depositedAmount' | 'currentAllowances'>,
  targetDeposit: bigint
): {
  delta: bigint
  clampedTarget: bigint
  lockupUsed: bigint
} {
  if (targetDeposit < 0n) throw new Error('target deposit cannot be negative')
  const lockupUsed = status.currentAllowances.lockupUsed ?? 0n
  const clampedTarget = targetDeposit < lockupUsed ? lockupUsed : targetDeposit
  const delta = clampedTarget - status.depositedAmount
  return { delta, clampedTarget, lockupUsed }
}

/**
 * Calculate storage capacity insights for a deposit amount assuming unrestricted
 * allowances (max trusted WarmStorage configuration).
 */
export function calculateDepositCapacity(
  depositAmount: bigint,
  pricePerTiBPerEpoch: bigint
): {
  tibPerMonth: number
  gibPerMonth: number
  monthlyPayment: bigint
  requiredLockup: bigint
  totalRequired: bigint
  isDepositSufficient: boolean
} {
  if (pricePerTiBPerEpoch === 0n) {
    return {
      tibPerMonth: 0,
      gibPerMonth: 0,
      monthlyPayment: 0n,
      requiredLockup: 0n,
      totalRequired: 0n,
      isDepositSufficient: true,
    }
  }

  const epochsIn10Days = BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY
  const epochsPerMonth = TIME_CONSTANTS.EPOCHS_PER_MONTH

  const maxRatePerEpoch = (depositAmount * BUFFER_DENOMINATOR) / (epochsIn10Days * BUFFER_NUMERATOR)

  const tibPerMonth = calculateActualCapacity(maxRatePerEpoch, pricePerTiBPerEpoch)
  const gibPerMonth = tibPerMonth * 1024

  const monthlyPayment = maxRatePerEpoch * epochsPerMonth
  const requiredLockup = maxRatePerEpoch * epochsIn10Days
  const totalRequired = withBuffer(requiredLockup)

  return {
    tibPerMonth,
    gibPerMonth,
    monthlyPayment,
    requiredLockup,
    totalRequired,
    isDepositSufficient: depositAmount >= totalRequired,
  }
}

/**
 * Derive allowance requirements from a CAR size using current TiB pricing.
 */
export function calculateRequiredAllowances(carSizeBytes: number, pricePerTiBPerEpoch: bigint): StorageAllowances {
  const storageTiB = carSizeBytes / Number(SIZE_CONSTANTS.TiB)
  return calculateStorageAllowances(storageTiB, pricePerTiBPerEpoch)
}

/**
 * Summarize storage runway from current deposit and allowance usage. Returns a
 * structured payload that callers can render for CLI, web, or automated flows.
 */
export function calculateStorageRunway(
  status?: Pick<PaymentStatus, 'depositedAmount' | 'currentAllowances'> | null
): StorageRunwaySummary {
  if (!status || !status.currentAllowances) {
    return {
      state: 'unknown',
      available: 0n,
      rateUsed: 0n,
      perDay: 0n,
      lockupUsed: 0n,
      days: 0,
      hours: 0,
    }
  }

  const rateUsed = status.currentAllowances.rateUsed ?? 0n
  const lockupUsed = status.currentAllowances.lockupUsed ?? 0n
  const depositedAmount = status.depositedAmount ?? 0n
  const available = depositedAmount > lockupUsed ? depositedAmount - lockupUsed : 0n

  if (rateUsed === 0n) {
    return {
      state: 'no-spend',
      available,
      rateUsed,
      perDay: 0n,
      lockupUsed,
      days: 0,
      hours: 0,
    }
  }

  const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
  if (perDay === 0n) {
    return {
      state: 'no-spend',
      available,
      rateUsed,
      perDay,
      lockupUsed,
      days: 0,
      hours: 0,
    }
  }

  const runwayDays = Number(available / perDay)
  const runwayHoursRemainder = Number(((available % perDay) * 24n) / perDay)

  return {
    state: 'active',
    available,
    rateUsed,
    perDay,
    lockupUsed,
    days: runwayDays,
    hours: runwayHoursRemainder,
  }
}

/**
 * Validate that a wallet meets the minimum requirements for initiating
 * storage operations (sufficient FIL for gas, presence of USDFC balance).
 *
 * Returns a structured result so callers can surface helpful error messaging
 * without duplicating business logic.
 */
export function validatePaymentRequirements(
  hasSufficientGas: boolean,
  usdfcBalance: bigint,
  isCalibnet: boolean
): PaymentValidationResult {
  if (!hasSufficientGas) {
    const result: PaymentValidationResult = {
      isValid: false,
      errorMessage: 'Insufficient FIL for gas fees',
    }
    if (isCalibnet) {
      result.helpMessage = 'Get test FIL from: https://faucet.calibnet.chainsafe-fil.io/'
    }
    return result
  }

  if (usdfcBalance === 0n) {
    return {
      isValid: false,
      errorMessage: 'No USDFC tokens found',
      helpMessage: isCalibnet
        ? 'Get test USDFC from: https://docs.secured.finance/usdfc-stablecoin/getting-started/getting-test-usdfc-on-testnet'
        : 'Mint USDFC with FIL: https://docs.secured.finance/usdfc-stablecoin/getting-started/minting-usdfc-step-by-step',
    }
  }

  return { isValid: true }
}

/**
 * Set WarmStorage service approvals to explicitly defined rate/lockup values.
 *
 * @param synapse - Initialized Synapse instance.
 * @param rateAllowance - Maximum rate per epoch in USDFC.
 * @param lockupAllowance - Maximum lockup amount in USDFC.
 * @returns The transaction hash for the approval update.
 */
export async function setServiceApprovals(
  synapse: Synapse,
  rateAllowance: bigint,
  lockupAllowance: bigint
): Promise<string> {
  const warmStorageAddress = synapse.getWarmStorageAddress()

  const maxLockupPeriod = BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY

  const tx = await synapse.payments.approveService(
    warmStorageAddress,
    rateAllowance,
    lockupAllowance,
    maxLockupPeriod,
    TOKENS.USDFC
  )

  await tx.wait()
  return tx.hash
}

/**
 * Check whether WarmStorage allowances are already configured at maximum.
 *
 * @param synapse - Initialized Synapse instance.
 * @returns Current allowances and a flag indicating if an update is required.
 */
export async function checkAllowances(synapse: Synapse): Promise<{
  needsUpdate: boolean
  currentAllowances: ServiceApprovalStatus
}> {
  const warmStorageAddress = synapse.getWarmStorageAddress()
  const currentAllowances = await synapse.payments.serviceApproval(warmStorageAddress, TOKENS.USDFC)

  const needsUpdate =
    currentAllowances.rateAllowance < MAX_RATE_ALLOWANCE || currentAllowances.lockupAllowance < MAX_LOCKUP_ALLOWANCE

  return {
    needsUpdate,
    currentAllowances,
  }
}

/**
 * Set WarmStorage allowances to maximum values, treating it as a trusted service.
 *
 * @param synapse - Initialized Synapse instance.
 * @returns Updated allowances plus the transaction hash if an on-chain update occurred.
 */
export async function setMaxAllowances(synapse: Synapse): Promise<{
  transactionHash: string
  currentAllowances: ServiceApprovalStatus
}> {
  const warmStorageAddress = synapse.getWarmStorageAddress()
  const transactionHash = await setServiceApprovals(synapse, MAX_RATE_ALLOWANCE, MAX_LOCKUP_ALLOWANCE)
  const currentAllowances = await synapse.payments.serviceApproval(warmStorageAddress, TOKENS.USDFC)

  return {
    transactionHash,
    currentAllowances,
  }
}

/**
 * Ensure WarmStorage allowances are at maximum, updating them if necessary.
 *
 * @param synapse - Initialized Synapse instance.
 * @returns Whether an update occurred, and the latest allowances.
 */
export async function checkAndSetAllowances(synapse: Synapse): Promise<{
  updated: boolean
  transactionHash?: string
  currentAllowances: ServiceApprovalStatus
}> {
  const allowanceStatus = await checkAllowances(synapse)

  if (allowanceStatus.needsUpdate) {
    const setResult = await setMaxAllowances(synapse)
    return {
      updated: true,
      transactionHash: setResult.transactionHash,
      currentAllowances: setResult.currentAllowances,
    }
  }

  return {
    updated: false,
    currentAllowances: allowanceStatus.currentAllowances,
  }
}

/**
 * Validate payment capacity for a specific CAR file.
 *
 * Ensures allowances are configured and that the existing deposit can cover the
 * required lockup for the upload, returning suggestions when additional funds
 * are recommended.
 *
 * @param synapse - Initialized Synapse instance.
 * @param carSizeBytes - Size of the CAR file in bytes.
 * @returns Capacity check result describing readiness and guidance.
 */
export async function validatePaymentCapacity(synapse: Synapse, carSizeBytes: number): Promise<PaymentCapacityCheck> {
  const allowanceResult = await checkAndSetAllowances(synapse)

  const [depositedAmount, storageInfo] = await Promise.all([
    synapse.payments.balance(TOKENS.USDFC),
    synapse.storage.getStorageInfo(),
  ])

  const currentAllowances = allowanceResult.currentAllowances
  const pricePerTiBPerEpoch = storageInfo.pricing.noCDN.perTiBPerEpoch
  const storageTiB = carSizeBytes / Number(SIZE_CONSTANTS.TiB)

  const required = calculateRequiredAllowances(carSizeBytes, pricePerTiBPerEpoch)
  const totalDepositNeeded = withBuffer(required.lockupAllowance)

  const result: PaymentCapacityCheck = {
    canUpload: true,
    storageTiB,
    required,
    issues: {},
    suggestions: [],
  }

  if (depositedAmount < totalDepositNeeded) {
    result.canUpload = false
    result.issues.insufficientDeposit = totalDepositNeeded - depositedAmount
    const depositNeeded = ethers.formatUnits(totalDepositNeeded - depositedAmount, 18)
    result.suggestions.push(`Deposit at least ${depositNeeded} USDFC`)
  }

  const totalLockupAfter = (currentAllowances.lockupUsed ?? 0n) + required.lockupAllowance
  if (totalLockupAfter > withoutBuffer(depositedAmount) && result.canUpload) {
    const additionalDeposit = ethers.formatUnits(withBuffer(totalLockupAfter) - depositedAmount, 18)
    result.suggestions.push(`Consider depositing ${additionalDeposit} more USDFC for safety margin`)
  }

  return result
}
