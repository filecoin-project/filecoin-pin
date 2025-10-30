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
 * @module synapse/payments
 */

import { SIZE_CONSTANTS, type Synapse, TIME_CONSTANTS, TOKENS } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'
import { isSessionKeyMode } from '../synapse/index.js'

// Constants
export const USDFC_DECIMALS = 18
const MIN_FIL_FOR_GAS = ethers.parseEther('0.1') // Minimum FIL padding for gas
export const DEFAULT_LOCKUP_DAYS = 10 // WarmStorage requires 10 days lockup

// Maximum allowances for trusted WarmStorage service
// Using MaxUint256 which MetaMask displays as "Unlimited"
const MAX_RATE_ALLOWANCE = ethers.MaxUint256
const MAX_LOCKUP_ALLOWANCE = ethers.MaxUint256

// Standard buffer configuration (10%) used across deposit/lockup calculations
const BUFFER_NUMERATOR = 11n
const BUFFER_DENOMINATOR = 10n

// Helper to apply a buffer on top of a base amount
function withBuffer(amount: bigint): bigint {
  return (amount * BUFFER_NUMERATOR) / BUFFER_DENOMINATOR
}

// Helper to remove the buffer (inverse of withBuffer)
function withoutBuffer(amount: bigint): bigint {
  return (amount * BUFFER_DENOMINATOR) / BUFFER_NUMERATOR
}

/**
 * Maximum precision scale used when converting small TiB (as a float) to integer(BigInt) math
 */
export const STORAGE_SCALE_MAX = 10_000_000
const STORAGE_SCALE_MAX_BI = BigInt(STORAGE_SCALE_MAX)

/**
 * Compute adaptive integer scaling for a TiB value so that
 * Math.floor(storageTiB * scale) stays within Number.MAX_SAFE_INTEGER.
 * This allows us to handle numbers as small as 1/10_000_000 TiB and as large as Number.MAX_SAFE_INTEGER TiB (> 1 YiB)
 */
export function getStorageScale(storageTiB: number): number {
  if (storageTiB <= 0) return 1
  const maxScaleBySafe = Math.floor(Number.MAX_SAFE_INTEGER / storageTiB)
  return Math.max(1, Math.min(STORAGE_SCALE_MAX, maxScaleBySafe))
}

/**
 * Service approval status from the Payments contract
 */
export interface ServiceApprovalStatus {
  rateAllowance: bigint
  lockupAllowance: bigint
  lockupUsed: bigint
  maxLockupPeriod?: bigint
  rateUsed?: bigint
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

/**
 * Check FIL balance for gas fees
 *
 * Example usage:
 * ```typescript
 * const synapse = await Synapse.create({ privateKey, rpcURL })
 * const filStatus = await checkFILBalance(synapse)
 *
 * if (filStatus.balance === 0n) {
 *   console.log('Account does not exist on-chain or has no FIL')
 * } else if (!filStatus.hasSufficientGas) {
 *   console.log('Insufficient FIL for gas fees')
 * }
 * ```
 *
 * @param synapse - Initialized Synapse instance
 * @returns Balance information and network type
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
    const signer = synapse.getClient() // owner wallet
    const address = await signer.getAddress()

    // Get native token balance
    const balance = await provider.getBalance(address)

    // Check if balance is sufficient for gas
    const hasSufficientGas = balance >= MIN_FIL_FOR_GAS

    return {
      balance,
      isCalibnet,
      hasSufficientGas,
    }
  } catch (_error) {
    // Account doesn't exist or network error
    return {
      balance: 0n,
      isCalibnet,
      hasSufficientGas: false,
    }
  }
}

/**
 * Check USDFC token balance in wallet
 *
 * Example usage:
 * ```typescript
 * const synapse = await Synapse.create({ privateKey, rpcURL })
 * const walletUsdfcBalance = await checkUSDFCBalance(synapse)
 *
 * if (walletUsdfcBalance === 0n) {
 *   console.log('No USDFC tokens found')
 * } else {
 *   const formatted = ethers.formatUnits(walletUsdfcBalance, USDFC_DECIMALS)
 *   console.log(`USDFC Balance: ${formatted}`)
 * }
 * ```
 *
 * @param synapse - Initialized Synapse instance
 * @returns bigint USDFC balance in wallet (0 if account doesn't exist or has no balance)
 */
export async function checkUSDFCBalance(synapse: Synapse): Promise<bigint> {
  try {
    // Get wallet balance (not deposited balance)
    const balance = await synapse.payments.walletBalance(TOKENS.USDFC)
    return balance
  } catch (_error) {
    // Account doesn't exist, has no FIL for gas, or contract call failed
    // Treat as having 0 USDFC
    return 0n
  }
}

/**
 * Get deposited USDFC balance in Payments contract
 *
 * This is different from wallet balance - it's the amount
 * already deposited and available for payment rails.
 *
 * @param synapse - Initialized Synapse instance
 * @returns Deposited USDFC balance in its smallest unit
 */
export async function getDepositedBalance(synapse: Synapse): Promise<bigint> {
  const filecoinPayBalance = await synapse.payments.balance(TOKENS.USDFC)
  return filecoinPayBalance
}

/**
 * Get current payment status including all balances and approvals
 *
 * Example usage:
 * ```typescript
 * const status = await getPaymentStatus(synapse)
 * console.log(`Address: ${status.address}`)
 * console.log(`FIL Balance: ${ethers.formatEther(status.filBalance)}`)
 * console.log(`USDFC Balance: ${ethers.formatUnits(status.walletUsdfcBalance, 18)}`)
 * console.log(`Deposited: ${ethers.formatUnits(status.filecoinPayBalance, 18)}`)
 * ```
 *
 * @param synapse - Initialized Synapse instance
 * @returns Complete payment status
 */
export async function getPaymentStatus(synapse: Synapse): Promise<PaymentStatus> {
  const client = synapse.getClient() // Use owner wallet, not session key
  const network = synapse.getNetwork()
  const warmStorageAddress = synapse.getWarmStorageAddress()

  // Run all async operations in parallel for efficiency
  const [address, filStatus, walletUsdfcBalance, filecoinPayBalance, currentAllowances] = await Promise.all([
    client.getAddress(),
    checkFILBalance(synapse),
    checkUSDFCBalance(synapse),
    getDepositedBalance(synapse),
    synapse.payments.serviceApproval(warmStorageAddress, TOKENS.USDFC),
  ])

  return {
    network,
    address,
    filBalance: filStatus.balance,
    walletUsdfcBalance,
    filecoinPayBalance,
    currentAllowances,
  }
}

export interface PaymentValidationResult {
  isValid: boolean
  errorMessage?: string
  helpMessage?: string
}

export function validatePaymentRequirements(
  hasSufficientGas: boolean,
  walletUsdfcBalance: bigint,
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

  if (walletUsdfcBalance === 0n) {
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
 * Deposit USDFC into the Payments contract
 *
 * This demonstrates the two-step process required for depositing ERC20 tokens:
 * 1. Approve the Payments contract to spend USDFC (standard ERC20 approval)
 * 2. Call deposit to move funds into the Payments contract
 *
 * Example usage:
 * ```typescript
 * const amountToDeposit = ethers.parseUnits('100', 18) // 100 USDFC
 * const { approvalTx, depositTx } = await depositUSDFC(synapse, amountToDeposit)
 * console.log(`Deposit transaction: ${depositTx}`)
 * ```
 *
 * @param synapse - Initialized Synapse instance
 * @param amount - Amount to deposit in USDFC (with decimals)
 * @returns Transaction hashes for approval and deposit
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

  // Step 2: Approve if needed (skip if already approved)
  if (currentAllowance < amount) {
    const approveTx = await synapse.payments.approve(paymentsAddress, amount, TOKENS.USDFC)
    await approveTx.wait()
    approvalTx = approveTx.hash
  }

  // Step 3: Make the deposit
  const depositTransaction = await synapse.payments.deposit(amount, TOKENS.USDFC)
  await depositTransaction.wait()

  const result: { approvalTx?: string; depositTx: string } = {
    depositTx: depositTransaction.hash,
  }

  if (approvalTx) {
    result.approvalTx = approvalTx
  }

  return result
}

/**
 * Withdraw USDFC from the Payments contract back to the wallet
 *
 * Example usage:
 * ```typescript
 * const amountToWithdraw = ethers.parseUnits('10', 18) // 10 USDFC
 * const txHash = await withdrawUSDFC(synapse, amountToWithdraw)
 * console.log(`Withdraw transaction: ${txHash}`)
 * ```
 *
 * @param synapse - Initialized Synapse instance
 * @param amount - Amount to withdraw in USDFC (with decimals)
 * @returns Transaction hash for the withdrawal
 */
export async function withdrawUSDFC(synapse: Synapse, amount: bigint): Promise<string> {
  const tx = await synapse.payments.withdraw(amount, TOKENS.USDFC)
  await tx.wait()
  return tx.hash
}

/**
 * Set service approvals for WarmStorage operator
 *
 * This authorizes the WarmStorage contract to create payment rails on behalf
 * of the user. The approval consists of three parameters:
 * - Rate allowance: Maximum payment rate per epoch (30 seconds)
 * - Lockup allowance: Maximum funds that can be locked at once
 * - Max lockup period: How far in advance funds can be locked (in epochs)
 *
 * Example usage:
 * ```typescript
 * // Allow up to 10 USDFC per epoch rate, 1000 USDFC total lockup
 * const rate = ethers.parseUnits('10', 18)
 * const lockup = ethers.parseUnits('1000', 18)
 * const txHash = await setServiceApprovals(synapse, rate, lockup)
 * console.log(`Approval transaction: ${txHash}`)
 * ```
 *
 * @param synapse - Initialized Synapse instance
 * @param rateAllowance - Maximum rate per epoch in USDFC
 * @param lockupAllowance - Maximum lockup amount in USDFC
 * @returns Transaction hash
 */
export async function setServiceApprovals(
  synapse: Synapse,
  rateAllowance: bigint,
  lockupAllowance: bigint
): Promise<string> {
  const warmStorageAddress = synapse.getWarmStorageAddress()

  // Max lockup period is always 10 days worth of epochs for WarmStorage
  const maxLockupPeriod = BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY

  // Set the service approval
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
 * Check if WarmStorage allowances are at maximum
 *
 * This function checks whether the current allowances for WarmStorage
 * are already set to maximum values (effectively infinite).
 *
 * @param synapse - Initialized Synapse instance
 * @returns Current allowances and whether they need updating
 */
export async function checkAllowances(synapse: Synapse): Promise<{
  needsUpdate: boolean
  currentAllowances: ServiceApprovalStatus
}> {
  const warmStorageAddress = synapse.getWarmStorageAddress()

  // Get current allowances
  const currentAllowances = await synapse.payments.serviceApproval(warmStorageAddress, TOKENS.USDFC)

  // Check if we need to update (not at max)
  const needsUpdate =
    currentAllowances.rateAllowance < MAX_RATE_ALLOWANCE || currentAllowances.lockupAllowance < MAX_LOCKUP_ALLOWANCE

  return {
    needsUpdate,
    currentAllowances,
  }
}

/**
 * Set WarmStorage allowances to maximum
 *
 * This function sets the allowances for WarmStorage to maximum values,
 * effectively treating it as a fully trusted service.
 *
 * @param synapse - Initialized Synapse instance
 * @returns Transaction hash and updated allowances
 */
export async function setMaxAllowances(synapse: Synapse): Promise<{
  transactionHash: string
  currentAllowances: ServiceApprovalStatus
}> {
  const warmStorageAddress = synapse.getWarmStorageAddress()

  // Set to maximum allowances
  const txHash = await setServiceApprovals(synapse, MAX_RATE_ALLOWANCE, MAX_LOCKUP_ALLOWANCE)

  // Return updated allowances
  const updatedAllowances = await synapse.payments.serviceApproval(warmStorageAddress, TOKENS.USDFC)

  return {
    transactionHash: txHash,
    currentAllowances: updatedAllowances,
  }
}

/**
 * Check and automatically set WarmStorage allowances to maximum if needed
 *
 * This function treats WarmStorage as a fully trusted service and ensures
 * that rate and lockup allowances are always set to maximum values.
 * This simplifies the user experience by removing the need to understand
 * and configure complex allowance settings by assuming that WarmStorage
 * can be fully trusted to manage payments on the user's behalf.
 *
 * The function will:
 * 1. Check current allowances for WarmStorage
 * 2. If either is not at maximum, update them to MAX_UINT256
 * 3. Return information about what was done
 *
 * **Session Key Authentication**: When using session key authentication,
 * this function will not attempt to update allowances since payment
 * operations require the owner wallet to sign. The function will return
 * `updated: false` and current allowances, which may not be at maximum.
 *
 * Example usage:
 * ```typescript
 * // Call before any operation that requires payments
 * const result = await checkAndSetAllowances(synapse)
 * if (result.updated) {
 *   console.log(`Allowances updated: ${result.transactionHash}`)
 * }
 * ```
 *
 * @param synapse - Initialized Synapse instance
 * @returns Result indicating if allowances were updated and transaction hash if applicable
 */
export async function checkAndSetAllowances(synapse: Synapse): Promise<{
  updated: boolean
  transactionHash?: string
  currentAllowances: ServiceApprovalStatus
}> {
  // Skip automatic updates in session key mode
  const sessionKeyMode = isSessionKeyMode(synapse)

  const checkResult = await checkAllowances(synapse)

  if (checkResult.needsUpdate && !sessionKeyMode) {
    const setResult = await setMaxAllowances(synapse)
    return {
      updated: true,
      transactionHash: setResult.transactionHash,
      currentAllowances: setResult.currentAllowances,
    }
  }

  return {
    updated: false,
    currentAllowances: checkResult.currentAllowances,
  }
}

/**
 * Calculate storage allowances from TiB per month
 *
 * This utility converts human-friendly storage units (TiB/month) into the
 * epoch-based rates required by the payment system. It uses the actual
 * pricing from the storage service to calculate accurate allowances.
 *
 * Example usage:
 * ```typescript
 * const storageInfo = await synapse.storage.getStorageInfo()
 * const pricing = storageInfo.pricing.noCDN.perTiBPerEpoch
 *
 * // Calculate allowances for 10 TiB/month
 * const allowances = calculateStorageAllowances(10, pricing)
 * console.log(`Rate needed: ${ethers.formatUnits(allowances.rateAllowance, 18)} USDFC/epoch`)
 * ```
 *
 * @param storageTiB - Desired storage capacity in TiB/month
 * @param pricePerTiBPerEpoch - Current pricing from storage service
 * @returns Calculated allowances for the specified capacity
 */
export function calculateStorageAllowances(storageTiB: number, pricePerTiBPerEpoch: bigint): StorageAllowances {
  // Use adaptive scaling to avoid Number overflow/precision issues for very large values
  // and to preserve precision for small fractional values.
  const scale = getStorageScale(storageTiB)
  const scaledStorage = Math.floor(storageTiB * scale)
  // Calculate rate allowance (per epoch payment)
  const rateAllowance = (pricePerTiBPerEpoch * BigInt(scaledStorage)) / BigInt(scale)

  // Calculate lockup allowance (10 days worth)
  const epochsIn10Days = BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY
  const lockupAllowance = rateAllowance * epochsIn10Days

  return {
    rateAllowance,
    lockupAllowance,
    storageCapacityTiB: storageTiB,
  }
}

/**
 * Calculate actual storage capacity from current allowances
 *
 * This is the inverse of calculateStorageAllowances - it determines how much
 * storage capacity the current allowances support.
 *
 * @param rateAllowance - Current rate allowance in its smallest unit
 * @param pricePerTiBPerEpoch - Current pricing from storage service
 * @returns Storage capacity in TiB that can be supported
 */
export function calculateActualCapacity(rateAllowance: bigint, pricePerTiBPerEpoch: bigint): number {
  if (pricePerTiBPerEpoch === 0n) return 0

  // Calculate TiB capacity from rate allowance
  const scaledQuotient = (rateAllowance * STORAGE_SCALE_MAX_BI) / pricePerTiBPerEpoch
  if (scaledQuotient > 0n) {
    return Number(scaledQuotient) / STORAGE_SCALE_MAX
  }

  // fallback for very small values that underflow to 0 after integer division
  const rateFloat = Number(ethers.formatUnits(rateAllowance, USDFC_DECIMALS))
  const priceFloat = Number(ethers.formatUnits(pricePerTiBPerEpoch, USDFC_DECIMALS))
  if (!Number.isFinite(rateFloat) || !Number.isFinite(priceFloat) || priceFloat === 0) {
    return 0
  }
  return rateFloat / priceFloat
}

/**
 * Calculate storage capacity from USDFC amount
 *
 * Determines how much storage can be purchased with a given USDFC amount,
 * accounting for the 10-day lockup period.
 *
 * @param usdfcAmount - Amount of USDFC in its smallest unit
 * @param pricePerTiBPerEpoch - Current pricing from storage service
 * @returns Storage capacity in TiB/month
 */
export function calculateStorageFromUSDFC(usdfcAmount: bigint, pricePerTiBPerEpoch: bigint): number {
  if (pricePerTiBPerEpoch === 0n) return 0

  // Calculate how much this covers for 10 days
  const epochsIn10Days = BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY
  const ratePerEpoch = usdfcAmount / epochsIn10Days

  return calculateActualCapacity(ratePerEpoch, pricePerTiBPerEpoch)
}

/**
 * Compute the additional deposit required to fund current usage for a duration.
 *
 * The WarmStorage service maintains ~10 days of lockup (lockupUsed) and draws future
 * lockups from the available deposit (deposited - lockupUsed). To keep the current
 * rails alive for N days, ensure available >= N days of spend at the current rateUsed.
 *
 * @param status - Current payment status (from getPaymentStatus)
 * @param days - Number of days to keep the current usage funded
 * @returns Breakdown of required top-up and related values
 */
export function computeTopUpForDuration(
  status: PaymentStatus,
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
      available: status.filecoinPayBalance > lockupUsed ? status.filecoinPayBalance - lockupUsed : 0n,
      rateUsed,
      perDay: rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY,
      lockupUsed,
    }
  }

  if (rateUsed === 0n) {
    return {
      topUp: 0n,
      available: status.filecoinPayBalance > lockupUsed ? status.filecoinPayBalance - lockupUsed : 0n,
      rateUsed,
      perDay: 0n,
      lockupUsed,
    }
  }

  const epochsNeeded = BigInt(Math.ceil(days)) * TIME_CONSTANTS.EPOCHS_PER_DAY
  const spendNeeded = rateUsed * epochsNeeded
  const available = status.filecoinPayBalance > lockupUsed ? status.filecoinPayBalance - lockupUsed : 0n

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
 * Compute the exact adjustment (deposit or withdraw) needed to set runway to `days`.
 *
 * Positive result indicates a deposit is needed; negative indicates a withdrawal is possible.
 */
export function computeAdjustmentForExactDays(
  status: PaymentStatus,
  days: number
): {
  delta: bigint // >0 deposit, <0 withdraw, 0 none
  targetAvailable: bigint
  available: bigint
  rateUsed: bigint
  perDay: bigint
  lockupUsed: bigint
} {
  const rateUsed = status.currentAllowances.rateUsed ?? 0n
  const lockupUsed = status.currentAllowances.lockupUsed ?? 0n
  const available = status.filecoinPayBalance > lockupUsed ? status.filecoinPayBalance - lockupUsed : 0n
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

  // Safety buffer to ensure runway >= requested days even if rateUsed shifts slightly.
  // Use a 1-hour buffer by default.
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
 * Compute the exact adjustment (deposit or withdraw) to reach a target absolute deposit.
 *
 * Clamps to not withdraw below the currently locked amount.
 */
export function computeAdjustmentForExactDeposit(
  status: PaymentStatus,
  targetDeposit: bigint
): {
  delta: bigint // >0 deposit, <0 withdraw, 0 none
  clampedTarget: bigint
  lockupUsed: bigint
} {
  if (targetDeposit < 0n) throw new Error('target deposit cannot be negative')
  const lockupUsed = status.currentAllowances.lockupUsed ?? 0n
  const clampedTarget = targetDeposit < lockupUsed ? lockupUsed : targetDeposit
  const delta = clampedTarget - status.filecoinPayBalance
  return { delta, clampedTarget, lockupUsed }
}

/**
 * Compute adjustment needed to maintain target runway AFTER adding a new piece
 *
 * This function accounts for both:
 * - The new piece's lockup requirement
 * - The new piece's ongoing per-epoch cost (rate)
 *
 * @param status - Current payment status
 * @param days - Target runway in days
 * @param pieceSizeBytes - Size of the piece (CAR, File, etc.) file being uploaded in bytes
 * @param pricePerTiBPerEpoch - Current pricing from storage service
 * @returns Adjustment details including total delta needed
 */
export function computeAdjustmentForExactDaysWithPiece(
  status: PaymentStatus,
  days: number,
  pieceSizeBytes: number,
  pricePerTiBPerEpoch: bigint
): {
  delta: bigint // >0 deposit, <0 withdraw, 0 none
  targetDeposit: bigint
  currentDeposit: bigint
  newLockupUsed: bigint
  newRateUsed: bigint
} {
  const currentRateUsed = status.currentAllowances.rateUsed ?? 0n
  const currentLockupUsed = status.currentAllowances.lockupUsed ?? 0n

  // Calculate required allowances for the new file
  const newPieceAllowances = calculateRequiredAllowances(pieceSizeBytes, pricePerTiBPerEpoch)

  // Calculate new totals after adding the piece
  const newRateUsed = currentRateUsed + newPieceAllowances.rateAllowance
  const newLockupUsed = currentLockupUsed + newPieceAllowances.lockupAllowance

  // Calculate deposit needed for target runway with new rate
  const perDay = newRateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY

  if (days < 0) {
    throw new Error('days must be non-negative')
  }

  // If no ongoing spend (both current and new), just need the lockup
  if (newRateUsed === 0n) {
    const targetDeposit = newLockupUsed
    const delta = targetDeposit - status.filecoinPayBalance
    return {
      delta,
      targetDeposit,
      currentDeposit: status.filecoinPayBalance,
      newLockupUsed,
      newRateUsed,
    }
  }

  // Safety buffer to ensure runway >= requested days even if rateUsed shifts slightly
  const perHour = perDay / 24n
  const safety = perHour > 0n ? perHour : 1n

  // Target: lockup (with buffer) + (days worth of ongoing cost)
  const targetAvailable = BigInt(Math.floor(days)) * perDay + safety
  const targetDeposit = withBuffer(newLockupUsed) + targetAvailable

  const delta = targetDeposit - status.filecoinPayBalance

  return {
    delta,
    targetDeposit,
    currentDeposit: status.filecoinPayBalance,
    newLockupUsed,
    newRateUsed,
  }
}

/**
 * Calculate storage capacity from deposit amount
 *
 * This function calculates how much storage capacity a deposit can support,
 * treating WarmStorage as fully trusted with max allowances, i.e. not
 * accounting for allowance limits. If usage limits need to be accounted for
 * then the capacity can be capped by either deposit or allowances.
 * This function accounts for the 10-day lockup requirement.
 *
 * @param depositAmount - Amount deposited in USDFC
 * @param pricePerTiBPerEpoch - Current pricing from storage service
 * @returns Storage capacity information
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

  // With infinite allowances, deposit is the only limiting factor
  // Deposit needs to cover: lockup (10 days) + at least some buffer
  const epochsIn10Days = BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY
  const epochsPerMonth = TIME_CONSTANTS.EPOCHS_PER_MONTH

  // Maximum storage we can support with this deposit
  // Reserve 10% for buffer beyond the lockup
  // Calculate max rate per epoch we can afford with deposit
  const maxRatePerEpoch = (depositAmount * BUFFER_DENOMINATOR) / (epochsIn10Days * BUFFER_NUMERATOR)

  // Convert to storage capacity
  const tibPerMonth = calculateActualCapacity(maxRatePerEpoch, pricePerTiBPerEpoch)
  const gibPerMonth = tibPerMonth * 1024

  // Calculate the actual costs for this capacity
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
 * Calculate required allowances from piece size
 *
 * Simple wrapper that converts piece size to storage allowances.
 *
 * @param pieceSizeBytes - Size of the piece (CAR, File, etc.) file in bytes
 * @param pricePerTiBPerEpoch - Current pricing from storage service
 * @returns Required allowances for the piece
 */
export function calculateRequiredAllowances(pieceSizeBytes: number, pricePerTiBPerEpoch: bigint): StorageAllowances {
  const storageTiB = pieceSizeBytes / Number(SIZE_CONSTANTS.TiB)
  return calculateStorageAllowances(storageTiB, pricePerTiBPerEpoch)
}

export function calculateStorageRunway(
  status?: Pick<PaymentStatus, 'filecoinPayBalance' | 'currentAllowances'> | null
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
  const filecoinPayBalance = status.filecoinPayBalance ?? 0n
  const available = filecoinPayBalance > lockupUsed ? filecoinPayBalance - lockupUsed : 0n

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
 * Validate payment capacity for a specific piece size
 *
 * This function checks if the deposit is sufficient for the piece upload. It
 * does not account for allowances since WarmStorage is assumed to be given
 * full trust with max allowances.
 *
 * **Note**: This function will attempt to automatically set max allowances
 * unless using session key authentication, in which case allowances must
 * be configured separately by the owner wallet.
 *
 * Example usage:
 * ```typescript
 * const fileSize = 10 * 1024 * 1024 * 1024 // 10 GiB
 * const capacity = await validatePaymentCapacity(synapse, fileSize)
 *
 * if (!capacity.canUpload) {
 *   console.error('Cannot upload file with current payment setup')
 *   capacity.suggestions.forEach(s => console.log(`  - ${s}`))
 * }
 * ```
 *
 * @param synapse - Initialized Synapse instance
 * @param pieceSizeBytes - Size of the piece (CAR, File, etc.) file in bytes
 * @returns Capacity check result
 */
export async function validatePaymentCapacity(synapse: Synapse, pieceSizeBytes: number): Promise<PaymentCapacityCheck> {
  // Ensure allowances are at max (automatically skips if in session key mode)
  await checkAndSetAllowances(synapse)

  // Get current status and pricing
  const [status, storageInfo] = await Promise.all([getPaymentStatus(synapse), synapse.storage.getStorageInfo()])

  const pricePerTiBPerEpoch = storageInfo.pricing.noCDN.perTiBPerEpoch
  const storageTiB = pieceSizeBytes / Number(SIZE_CONSTANTS.TiB)

  // Calculate requirements
  const required = calculateRequiredAllowances(pieceSizeBytes, pricePerTiBPerEpoch)
  const totalDepositNeeded = withBuffer(required.lockupAllowance)

  const result: PaymentCapacityCheck = {
    canUpload: true,
    storageTiB,
    required,
    issues: {},
    suggestions: [],
  }

  // Only check deposit
  if (status.filecoinPayBalance < totalDepositNeeded) {
    result.canUpload = false
    result.issues.insufficientDeposit = totalDepositNeeded - status.filecoinPayBalance
    const depositNeeded = ethers.formatUnits(totalDepositNeeded - status.filecoinPayBalance, 18)
    result.suggestions.push(`Deposit at least ${depositNeeded} USDFC`)
  }

  // Add warning if approaching deposit limit
  const totalLockupAfter = status.currentAllowances.lockupUsed + required.lockupAllowance
  if (totalLockupAfter > withoutBuffer(status.filecoinPayBalance) && result.canUpload) {
    const additionalDeposit = ethers.formatUnits(withBuffer(totalLockupAfter) - status.filecoinPayBalance, 18)
    result.suggestions.push(`Consider depositing ${additionalDeposit} more USDFC for safety margin`)
  }

  return result
}
