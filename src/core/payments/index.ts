/**
 * Synapse SDK Payment Operations
 *
 * This module demonstrates comprehensive payment operations using the Synapse SDK,
 * providing patterns for interacting with the Filecoin Onchain Cloud payment
 * system (Filecoin Pay).
 *
 * Key concepts demonstrated:
 * - Native FIL balance checking for gas fees
 * - ERC20 token (USDFC) balance management
 * - Two-step deposit process (approve + deposit)
 * - Service approval configuration for storage operators
 * - Storage capacity calculations from pricing
 *
 * @module core/payments
 */
import { SIZE_CONSTANTS, type Synapse, TIME_CONSTANTS, TOKENS } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'

// Constants

/** Number of decimal places used by USDFC tokens. */
export const USDFC_DECIMALS = 18

/** Default WarmStorage lockup period (days). WarmStorage requires a 10 day lockup. */
export const DEFAULT_LOCKUP_DAYS = 10

/**
 * Numerator/denominator pair representing the standard 10% buffer applied to
 * lockup requirements (adds a safety margin beyond the mandatory lockup).
 */
export const BUFFER_NUMERATOR = 11n
export const BUFFER_DENOMINATOR = 10n

/** Minimum FIL balance (in wei) recommended to cover gas fees. */
export const MIN_FIL_FOR_GAS = ethers.parseEther('0.1')

// Maximum allowances for trusted WarmStorage service.
// Using MaxUint256 matches the "Unlimited" allowance label shown in MetaMask.
const MAX_RATE_ALLOWANCE = ethers.MaxUint256
const MAX_LOCKUP_ALLOWANCE = ethers.MaxUint256

/**
 * Maximum integer scaling factor when converting TiB/month to epoch-based allowances.
 *
 * Keeps intermediate math within `Number.MAX_SAFE_INTEGER` while supporting tiny values down to
 * 1 / 10_000_000 TiB (~100 KB) and extremely large capacities (>1 YiB).
 */
export const STORAGE_SCALE_MAX = 10_000_000
const STORAGE_SCALE_MAX_BI = BigInt(STORAGE_SCALE_MAX)

export type StorageRunwayState = 'unknown' | 'no-spend' | 'active'

/** Service approval status from the Payments contract. */
export interface ServiceApprovalStatus {
  rateAllowance: bigint
  lockupAllowance: bigint
  lockupUsed: bigint
  maxLockupPeriod?: bigint
  rateUsed?: bigint
}

/** Complete payment status including balances and approvals. */
export interface PaymentStatus {
  network: string
  address: string
  filBalance: bigint
  usdfcBalance: bigint
  depositedAmount: bigint
  currentAllowances: ServiceApprovalStatus
}

/** Storage allowance calculation breakdown. */
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
 * Calculate storage allowances from a target TiB/month value.
 *
 * Converts human-friendly storage units into the epoch-based rate/lockup values expected by the
 * payment contracts. Uses adaptive scaling to maintain precision for small fractional TiB while
 * avoiding `Number.MAX_SAFE_INTEGER` overflow for very large capacities.
 *
 * Example usage:
 * ```typescript
 * const pricing = (await synapse.storage.getStorageInfo()).pricing.noCDN.perTiBPerEpoch
 * const allowances = calculateStorageAllowances(10, pricing)
 * console.log(`Rate needed: ${ethers.formatUnits(allowances.rateAllowance, 18)} USDFC/epoch`)
 * ```
 *
 * @param storageTiB - Desired storage capacity in TiB per month.
 * @param pricePerTiBPerEpoch - Current pricing from the storage service.
 * @returns Calculated rate and lockup allowances for the requested capacity.
 */
export function calculateStorageAllowances(storageTiB: number, pricePerTiBPerEpoch: bigint): StorageAllowances {
  // Use adaptive scaling to avoid precision loss for tiny TiB values and overflow for large ones
  const scale = getStorageScale(storageTiB)
  const scaledStorage = Math.floor(storageTiB * scale)
  // Per-epoch payment required for the desired capacity
  const rateAllowance = (pricePerTiBPerEpoch * BigInt(scaledStorage)) / BigInt(scale)

  // WarmStorage locks 10 days worth of spend up-front
  const epochsIn10Days = BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY
  const lockupAllowance = rateAllowance * epochsIn10Days

  return {
    rateAllowance,
    lockupAllowance,
    storageCapacityTiB: storageTiB,
  }
}

/**
 * Inverse of {@link calculateStorageAllowances}: derive TiB/month capacity supported by a rate allowance.
 *
 * Uses integer math where possible and falls back to floating point formatting for extremely small numbers
 * that would otherwise underflow.
 *
 * @param rateAllowance - Current rate allowance (per epoch) in the smallest denomination.
 * @param pricePerTiBPerEpoch - Current pricing from the storage service.
 * @returns Storage capacity in TiB per month.
 */
export function calculateActualCapacity(rateAllowance: bigint, pricePerTiBPerEpoch: bigint): number {
  if (pricePerTiBPerEpoch === 0n) return 0

  // Primary path: use scaled integer math for precision
  const scaledQuotient = (rateAllowance * STORAGE_SCALE_MAX_BI) / pricePerTiBPerEpoch
  if (scaledQuotient > 0n) {
    return Number(scaledQuotient) / STORAGE_SCALE_MAX
  }

  // Fallback for tiny values that underflow to zero in integer math
  const rateFloat = Number(ethers.formatUnits(rateAllowance, USDFC_DECIMALS))
  const priceFloat = Number(ethers.formatUnits(pricePerTiBPerEpoch, USDFC_DECIMALS))
  if (!Number.isFinite(rateFloat) || !Number.isFinite(priceFloat) || priceFloat === 0) {
    return 0
  }
  return rateFloat / priceFloat
}

/**
 * Determine storage capacity (TiB/month) purchasable with a USDFC amount.
 *
 * Accounts for the mandatory 10-day lockup by converting the deposit into a per-epoch spend before
 * delegating to {@link calculateActualCapacity}.
 *
 * @param usdfcAmount - Amount of USDFC in smallest denomination.
 * @param pricePerTiBPerEpoch - Current pricing from the storage service.
 * @returns Storage capacity purchasable with the provided amount.
 */
export function calculateStorageFromUSDFC(usdfcAmount: bigint, pricePerTiBPerEpoch: bigint): number {
  if (pricePerTiBPerEpoch === 0n) return 0

  const epochsIn10Days = BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY
  const ratePerEpoch = usdfcAmount / epochsIn10Days

  return calculateActualCapacity(ratePerEpoch, pricePerTiBPerEpoch)
}

/**
 * Compute the additional deposit required to keep current WarmStorage spend alive for a duration.
 *
 * WarmStorage maintains ~10 days of funds locked (`lockupUsed`) and draws future lockups from the
 * available deposit (`depositedAmount - lockupUsed`). To keep the current rails active for `days`,
 * ensure the available balance covers that many days at the current `rateUsed`.
 *
 * @param status - Current payment snapshot containing deposit and allowance usage.
 * @param days - Number of days to sustain the current spend.
 * @returns Breakdown detailing how much to top up and the related metrics.
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
 * Compute the exact adjustment (deposit or withdraw) required to reach a target runway in days.
 *
 * Positive `delta` indicates an additional deposit is needed; negative indicates funds could be withdrawn.
 * A one-hour safety buffer is added to avoid falling below the requested threshold as usage fluctuates.
 *
 * @param status - Current payment snapshot containing deposit and allowance usage.
 * @param days - Desired runway length in days.
 * @returns Summary including the delta required and supporting metrics.
 */
export function computeAdjustmentForExactDays(
  status: Pick<PaymentStatus, 'depositedAmount' | 'currentAllowances'>,
  days: number
): {
  delta: bigint // >0 deposit, <0 withdraw, 0 no change
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
  // Add a 1-hour safety buffer (or 1 wei if the rate is tiny) to avoid oscillations
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
 * Compute the adjustment (deposit or withdraw) needed to reach a target total deposit.
 *
 * Ensures we never withdraw below the funds currently locked by WarmStorage by clamping the target to
 * at least `lockupUsed`.
 *
 * @param status - Current payment snapshot containing deposit and allowance usage.
 * @param targetDeposit - Desired total deposit amount.
 * @returns Delta required to reach the clamped target and the computed lockup baseline.
 */
export function computeAdjustmentForExactDeposit(
  status: Pick<PaymentStatus, 'depositedAmount' | 'currentAllowances'>,
  targetDeposit: bigint
): {
  delta: bigint // >0 deposit, <0 withdraw, 0 no change
  clampedTarget: bigint
  lockupUsed: bigint
} {
  if (targetDeposit < 0n) throw new Error('target deposit cannot be negative')
  const lockupUsed = status.currentAllowances.lockupUsed ?? 0n
  // Never withdraw below the funds already locked on behalf of the service
  const clampedTarget = targetDeposit < lockupUsed ? lockupUsed : targetDeposit
  const delta = clampedTarget - status.depositedAmount
  return { delta, clampedTarget, lockupUsed }
}

/**
 * Calculate storage capacity insights for a deposit amount assuming unrestricted allowances.
 *
 * Treats WarmStorage as fully trusted (max allowances) so the deposit is the limiting factor. Applies the
 * 10-day lockup requirement and buffer so callers can determine how much capacity a given deposit unlocks.
 *
 * @param depositAmount - Amount deposited in USDFC (smallest denomination).
 * @param pricePerTiBPerEpoch - Current pricing from the storage service.
 * @returns Capacity information and whether the deposit fully covers the lockup + buffer.
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

  // Reserve a 10% buffer beyond the 10-day lockup requirement
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
 * Calculate required allowances from a CAR file size.
 *
 * Convenience wrapper that converts a file size in bytes into the rate/lockup allowances needed for an upload,
 * using the storage service's current TiB pricing.
 *
 * @param carSizeBytes - Size of the CAR file in bytes.
 * @param pricePerTiBPerEpoch - Current pricing from the storage service.
 * @returns Required rate and lockup allowances.
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
 * Deposit USDFC into the Payments contract.
 *
 * This demonstrates the two-step process required for depositing ERC20 tokens:
 * 1. Approve the Payments contract to spend USDFC (standard ERC20 approval).
 * 2. Call deposit to move funds into the Payments contract.
 *
 * The function detects existing allowance and only performs the approval step
 * when necessary to reduce unnecessary transactions.
 *
 * Example usage:
 * ```typescript
 * const amountToDeposit = ethers.parseUnits('100', 18)
 * const { approvalTx, depositTx } = await depositUSDFC(synapse, amountToDeposit)
 * console.log(`Deposit transaction: ${depositTx}`)
 * ```
 *
 * @param synapse - Initialized Synapse instance.
 * @param amount - Amount to deposit in USDFC (with decimals).
 * @returns Transaction hashes for approval (if performed) and deposit.
 */
export async function depositUSDFC(
  synapse: Synapse,
  amount: bigint
): Promise<{
  approvalTx?: string
  depositTx: string
}> {
  const paymentsAddress = synapse.getPaymentsAddress()

  // Step 1: Check current allowance
  const currentAllowance = await synapse.payments.allowance(paymentsAddress, TOKENS.USDFC)

  let approvalTx: string | undefined

  // Step 2: Approve if needed (skip when sufficient allowance already exists)
  if (currentAllowance < amount) {
    const approveTx = await synapse.payments.approve(paymentsAddress, amount, TOKENS.USDFC)
    await approveTx.wait()
    approvalTx = approveTx.hash
  }

  // Step 3: Perform the deposit
  const depositTransaction = await synapse.payments.deposit(amount, TOKENS.USDFC)
  await depositTransaction.wait()

  return {
    depositTx: depositTransaction.hash,
    ...(approvalTx ? { approvalTx } : {}),
  }
}

/**
 * Withdraw USDFC from the Payments contract back to the wallet.
 *
 * Example usage:
 * ```typescript
 * const amountToWithdraw = ethers.parseUnits('10', 18)
 * const txHash = await withdrawUSDFC(synapse, amountToWithdraw)
 * console.log(`Withdraw transaction: ${txHash}`)
 * ```
 *
 * @param synapse - Initialized Synapse instance.
 * @param amount - Amount to withdraw in USDFC (with decimals).
 * @returns Transaction hash for the withdrawal.
 */
export async function withdrawUSDFC(synapse: Synapse, amount: bigint): Promise<string> {
  const tx = await synapse.payments.withdraw(amount, TOKENS.USDFC)
  await tx.wait()
  return tx.hash
}

/**
 * Check FIL balance for gas fees.
 *
 * Example usage:
 * ```typescript
 * const filStatus = await checkFILBalance(synapse)
 *
 * if (filStatus.balance === 0n) {
 *   console.log('Account does not exist on-chain or has no FIL')
 * } else if (!filStatus.hasSufficientGas) {
 *   console.log('Insufficient FIL for gas fees')
 * }
 * ```
 *
 * @param synapse - Initialized Synapse instance.
 * @returns Balance information and network type.
 */
export async function checkFILBalance(synapse: Synapse): Promise<{
  balance: bigint
  isCalibnet: boolean
  hasSufficientGas: boolean
}> {
  const network = synapse.getNetwork()
  const isCalibnet = network === 'calibration'

  try {
    const provider = synapse.getProvider()
    const signer = synapse.getSigner()
    const address = await signer.getAddress()

    // Get the native FIL balance for the signer
    const balance = await provider.getBalance(address)
    const hasSufficientGas = balance >= MIN_FIL_FOR_GAS

    return {
      balance,
      isCalibnet,
      hasSufficientGas,
    }
  } catch {
    // Account may not exist yet or the RPC call failed; treat as empty balance
    return {
      balance: 0n,
      isCalibnet,
      hasSufficientGas: false,
    }
  }
}

/**
 * Check USDFC token balance in the wallet (not deposited balance).
 *
 * Example usage:
 * ```typescript
 * const usdfcBalance = await checkUSDFCBalance(synapse)
 * if (usdfcBalance === 0n) {
 *   console.log('No USDFC tokens found')
 * } else {
 *   console.log(`USDFC Balance: ${ethers.formatUnits(usdfcBalance, 18)}`)
 * }
 * ```
 *
 * @param synapse - Initialized Synapse instance.
 * @returns Wallet USDFC balance in wei (0 if account doesn't exist or has no balance).
 */
export async function checkUSDFCBalance(synapse: Synapse): Promise<bigint> {
  try {
    // Wallet balance (not the deposited contract balance)
    return await synapse.payments.walletBalance(TOKENS.USDFC)
  } catch {
    // Account missing, out of gas, or call failure - treat as zero balance
    return 0n
  }
}

/**
 * Get deposited USDFC balance in the Payments contract.
 *
 * This differs from the wallet balance; it reflects the funds already
 * deposited and available for payment rails.
 *
 * @param synapse - Initialized Synapse instance.
 * @returns Deposited USDFC balance in its smallest unit.
 */
export async function getDepositedBalance(synapse: Synapse): Promise<bigint> {
  return await synapse.payments.balance(TOKENS.USDFC)
}

/**
 * Get current payment status including wallet balances and approvals.
 *
 * Example usage:
 * ```typescript
 * const status = await getPaymentStatus(synapse)
 * console.log(`Address: ${status.address}`)
 * console.log(`FIL Balance: ${ethers.formatEther(status.filBalance)}`)
 * console.log(`USDFC Balance: ${ethers.formatUnits(status.usdfcBalance, 18)}`)
 * console.log(`Deposited: ${ethers.formatUnits(status.depositedAmount, 18)}`)
 * ```
 *
 * @param synapse - Initialized Synapse instance.
 * @returns Complete payment status.
 */
export async function getPaymentStatus(synapse: Synapse): Promise<PaymentStatus> {
  const signer = synapse.getSigner()
  const network = synapse.getNetwork()
  const warmStorageAddress = synapse.getWarmStorageAddress()

  // Run all async operations in parallel for efficiency
  const [address, filStatus, usdfcBalance, depositedAmount, currentAllowances] = await Promise.all([
    signer.getAddress(),
    checkFILBalance(synapse),
    checkUSDFCBalance(synapse),
    getDepositedBalance(synapse),
    synapse.payments.serviceApproval(warmStorageAddress, TOKENS.USDFC),
  ])

  return {
    network,
    address,
    filBalance: filStatus.balance,
    usdfcBalance,
    depositedAmount,
    currentAllowances,
  }
}

/**
 * Set service approvals for the WarmStorage operator.
 *
 * Authorizes WarmStorage to manage payment rails on behalf of the user. The approval requires:
 * - `rateAllowance`: Max payment rate per epoch (30 seconds)
 * - `lockupAllowance`: Max funds that can be locked at once
 * - `maxLockupPeriod`: How far in advance funds can be locked (expressed in epochs)
 *
 * Example usage:
 * ```typescript
 * const rate = ethers.parseUnits('10', 18)
 * const lockup = ethers.parseUnits('1000', 18)
 * const txHash = await setServiceApprovals(synapse, rate, lockup)
 * console.log(`Approval transaction: ${txHash}`)
 * ```
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

  // WarmStorage always locks funds for up to 10 days worth of epochs
  const maxLockupPeriod = BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY

  // Submit the approval transaction
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
 * Treats WarmStorage as a trusted service and inspects if both rate and lockup allowances are set
 * to effectively infinite values (`MaxUint256`). When either value is lower, an on-chain update is
 * required before uploads can proceed.
 *
 * @param synapse - Initialized Synapse instance.
 * @returns Current allowances and a flag indicating if an update is required.
 */
export async function checkAllowances(synapse: Synapse): Promise<{
  needsUpdate: boolean
  currentAllowances: ServiceApprovalStatus
}> {
  const warmStorageAddress = synapse.getWarmStorageAddress()
  // Retrieve the latest on-chain allowance configuration
  const currentAllowances = await synapse.payments.serviceApproval(warmStorageAddress, TOKENS.USDFC)

  // Needs update when either rate or lockup cap is below the trusted maximum
  const needsUpdate =
    currentAllowances.rateAllowance < MAX_RATE_ALLOWANCE || currentAllowances.lockupAllowance < MAX_LOCKUP_ALLOWANCE

  return {
    needsUpdate,
    currentAllowances,
  }
}

/**
 * Set WarmStorage allowances to maximum values, treating it as a fully trusted service.
 *
 * Writes the maximum possible rate and lockup limits (both `MaxUint256`) so WarmStorage can manage
 * payments without subsequent approvals. Returns the transaction hash along with the refreshed allowance state.
 *
 * @param synapse - Initialized Synapse instance.
 * @returns Updated allowances plus the transaction hash if an on-chain update occurred.
 */
export async function setMaxAllowances(synapse: Synapse): Promise<{
  transactionHash: string
  currentAllowances: ServiceApprovalStatus
}> {
  const warmStorageAddress = synapse.getWarmStorageAddress()
  // Push the max allowance configuration on-chain
  const transactionHash = await setServiceApprovals(synapse, MAX_RATE_ALLOWANCE, MAX_LOCKUP_ALLOWANCE)
  // Fetch the updated allowances for confirmation/reporting
  const currentAllowances = await synapse.payments.serviceApproval(warmStorageAddress, TOKENS.USDFC)

  return {
    transactionHash,
    currentAllowances,
  }
}

/**
 * Ensure WarmStorage allowances are at maximum, updating them if necessary.
 *
 * Convenience helper that checks current allowances and, when needed, performs the on-chain update to
 * set `MaxUint256` limits. This keeps higher-level flows simple when treating WarmStorage as a trusted operator.
 *
 * @param synapse - Initialized Synapse instance.
 * @returns Whether an update occurred, and the latest allowances.
 */
export async function checkAndSetAllowances(synapse: Synapse): Promise<{
  updated: boolean
  transactionHash?: string
  currentAllowances: ServiceApprovalStatus
}> {
  // Inspect the existing allowances before deciding if we need to update
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
 * Example usage:
 * ```typescript
 * const capacity = await validatePaymentCapacity(synapse, 10 * 1024 ** 3)
 * if (!capacity.canUpload) {
 *   console.error('Cannot upload file with current payment setup')
 *   capacity.suggestions.forEach(s => console.log(`  - ${s}`))
 * }
 * ```
 *
 * @param synapse - Initialized Synapse instance.
 * @param carSizeBytes - Size of the CAR file in bytes.
 * @returns Capacity check result describing readiness and guidance.
 */
export async function validatePaymentCapacity(synapse: Synapse, carSizeBytes: number): Promise<PaymentCapacityCheck> {
  // First ensure allowances are configured at maximum
  const allowanceResult = await checkAndSetAllowances(synapse)

  // Fetch the latest deposit balance and pricing in parallel
  const [depositedAmount, storageInfo] = await Promise.all([
    synapse.payments.balance(TOKENS.USDFC),
    synapse.storage.getStorageInfo(),
  ])

  const currentAllowances = allowanceResult.currentAllowances
  const pricePerTiBPerEpoch = storageInfo.pricing.noCDN.perTiBPerEpoch
  const storageTiB = carSizeBytes / Number(SIZE_CONSTANTS.TiB)

  // Calculate the allowances and deposit required for the upload
  const required = calculateRequiredAllowances(carSizeBytes, pricePerTiBPerEpoch)
  const totalDepositNeeded = withBuffer(required.lockupAllowance)

  const result: PaymentCapacityCheck = {
    canUpload: true,
    storageTiB,
    required,
    issues: {},
    suggestions: [],
  }

  // Deposit is insufficient to cover the required lockup (with buffer)
  if (depositedAmount < totalDepositNeeded) {
    result.canUpload = false
    result.issues.insufficientDeposit = totalDepositNeeded - depositedAmount
    const depositNeeded = ethers.formatUnits(totalDepositNeeded - depositedAmount, 18)
    result.suggestions.push(`Deposit at least ${depositNeeded} USDFC`)
  }

  // Warn when the resulting lockup would consume the buffered deposit
  const totalLockupAfter = (currentAllowances.lockupUsed ?? 0n) + required.lockupAllowance
  if (totalLockupAfter > withoutBuffer(depositedAmount) && result.canUpload) {
    const additionalDeposit = ethers.formatUnits(withBuffer(totalLockupAfter) - depositedAmount, 18)
    result.suggestions.push(`Consider depositing ${additionalDeposit} more USDFC for safety margin`)
  }

  return result
}
