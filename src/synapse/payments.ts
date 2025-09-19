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

import { type Synapse, TIME_CONSTANTS, TOKENS } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'

// Constants
export const USDFC_DECIMALS = 18
const MIN_FIL_FOR_GAS = ethers.parseEther('0.1') // Minimum FIL padding for gas
const DEFAULT_LOCKUP_DAYS = 10 // WarmStorage requires 10 days lockup

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
  usdfcBalance: bigint
  depositedAmount: bigint
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
    const signer = synapse.getSigner()
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
 * const usdfcBalance = await checkUSDFCBalance(synapse)
 *
 * if (usdfcBalance === 0n) {
 *   console.log('No USDFC tokens found')
 * } else {
 *   const formatted = ethers.formatUnits(usdfcBalance, USDFC_DECIMALS)
 *   console.log(`USDFC Balance: ${formatted}`)
 * }
 * ```
 *
 * @param synapse - Initialized Synapse instance
 * @returns USDFC balance in wei (0 if account doesn't exist or has no balance)
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
  const depositedAmount = await synapse.payments.balance(TOKENS.USDFC)
  return depositedAmount
}

/**
 * Get current payment status including all balances and approvals
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
 * @param synapse - Initialized Synapse instance
 * @returns Complete payment status
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
  // Calculate rate allowance (per epoch payment)
  const rateAllowance = (pricePerTiBPerEpoch * BigInt(Math.floor(storageTiB * 100))) / 100n

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
  const capacityTiB = Number((rateAllowance * 100n) / pricePerTiBPerEpoch) / 100
  return capacityTiB
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

  // Convert to TiB
  const capacityTiB = Number((ratePerEpoch * 100n) / pricePerTiBPerEpoch) / 100
  return capacityTiB
}

/**
 * Calculate required allowances from CAR file size
 *
 * Simple wrapper that converts file size to storage allowances.
 *
 * @param carSizeBytes - Size of the CAR file in bytes
 * @param pricePerTiBPerEpoch - Current pricing from storage service
 * @returns Required allowances for the file
 */
export function calculateRequiredAllowances(carSizeBytes: number, pricePerTiBPerEpoch: bigint): StorageAllowances {
  // Convert bytes to TiB (1 TiB = 1024^4 bytes)
  const bytesPerTiB = 1024 * 1024 * 1024 * 1024
  const storageTiB = carSizeBytes / bytesPerTiB
  return calculateStorageAllowances(storageTiB, pricePerTiBPerEpoch)
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
 * Validate payment capacity for a specific CAR file
 *
 * Checks if the current payment setup can handle uploading a specific file.
 * This is a focused check on capacity, not basic setup validation.
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
 * @param carSizeBytes - Size of the CAR file in bytes
 * @returns Capacity check result with specific issues
 */
export async function validatePaymentCapacity(synapse: Synapse, carSizeBytes: number): Promise<PaymentCapacityCheck> {
  // Get current status and pricing
  const [status, storageInfo] = await Promise.all([getPaymentStatus(synapse), synapse.storage.getStorageInfo()])

  const pricePerTiBPerEpoch = storageInfo.pricing.noCDN.perTiBPerEpoch
  const bytesPerTiB = 1024 * 1024 * 1024 * 1024
  const storageTiB = carSizeBytes / bytesPerTiB

  // Calculate requirements
  const required = calculateRequiredAllowances(carSizeBytes, pricePerTiBPerEpoch)
  const monthlyPayment = required.rateAllowance * TIME_CONSTANTS.EPOCHS_PER_MONTH
  const totalDepositNeeded = required.lockupAllowance + monthlyPayment

  const result: PaymentCapacityCheck = {
    canUpload: true,
    storageTiB,
    required,
    issues: {},
    suggestions: [],
  }

  // Check deposit
  if (status.depositedAmount < totalDepositNeeded) {
    result.canUpload = false
    result.issues.insufficientDeposit = totalDepositNeeded - status.depositedAmount
    const depositNeeded = ethers.formatUnits(totalDepositNeeded - status.depositedAmount, 18)
    result.suggestions.push(`Deposit at least ${depositNeeded} USDFC`)
  }

  // Check rate allowance
  if (status.currentAllowances.rateAllowance < required.rateAllowance) {
    result.canUpload = false
    result.issues.insufficientRateAllowance = required.rateAllowance - status.currentAllowances.rateAllowance
    const rateNeeded = ethers.formatUnits(required.rateAllowance, 18)
    result.suggestions.push(`Set rate allowance to at least ${rateNeeded} USDFC/epoch`)
  }

  // Check lockup allowance
  if (status.currentAllowances.lockupAllowance < required.lockupAllowance) {
    result.canUpload = false
    result.issues.insufficientLockupAllowance = required.lockupAllowance - status.currentAllowances.lockupAllowance
    const lockupNeeded = ethers.formatUnits(required.lockupAllowance, 18)
    result.suggestions.push(`Set lockup allowance to at least ${lockupNeeded} USDFC`)
  }

  // Add warning if approaching deposit limit
  const totalLockupAfter = status.currentAllowances.lockupUsed + required.lockupAllowance
  if (totalLockupAfter > (status.depositedAmount * 9n) / 10n && result.canUpload) {
    const additionalDeposit = ethers.formatUnits((totalLockupAfter * 11n) / 10n - status.depositedAmount, 18)
    result.suggestions.push(`Consider depositing ${additionalDeposit} more USDFC for safety margin`)
  }

  return result
}
