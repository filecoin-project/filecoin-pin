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
import {
  calculateRequiredAllowances,
  DEFAULT_LOCKUP_DAYS,
  type PaymentStatus,
  type ServiceApprovalStatus,
  type StorageAllowances,
  withBuffer,
  withoutBuffer,
} from '../core/payments/index.js'

export type { PaymentStatus, ServiceApprovalStatus, StorageAllowances } from '../core/payments/index.js'
export {
  BUFFER_DENOMINATOR,
  BUFFER_NUMERATOR,
  calculateActualCapacity,
  calculateDepositCapacity,
  calculateRequiredAllowances,
  calculateStorageAllowances,
  calculateStorageFromUSDFC,
  calculateStorageRunway,
  computeAdjustmentForExactDays,
  computeAdjustmentForExactDeposit,
  computeTopUpForDuration,
  DEFAULT_LOCKUP_DAYS,
  getStorageScale,
  STORAGE_SCALE_MAX,
  USDFC_DECIMALS,
  withBuffer,
  withoutBuffer,
} from '../core/payments/index.js'

const MIN_FIL_FOR_GAS = ethers.parseEther('0.1') // Minimum FIL padding for gas

// Maximum allowances for trusted WarmStorage service
// Using MaxUint256 which MetaMask displays as "Unlimited"
const MAX_RATE_ALLOWANCE = ethers.MaxUint256
const MAX_LOCKUP_ALLOWANCE = ethers.MaxUint256

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
  const checkResult = await checkAllowances(synapse)

  if (checkResult.needsUpdate) {
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
 * This function checks if the deposit is sufficient for the file upload. It
 * does not account for allowances since WarmStorage is assumed to be given
 * full trust with max allowances.
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
 * @returns Capacity check result
 */
export async function validatePaymentCapacity(synapse: Synapse, carSizeBytes: number): Promise<PaymentCapacityCheck> {
  // First ensure allowances are at max
  await checkAndSetAllowances(synapse)

  // Get current status and pricing
  const [status, storageInfo] = await Promise.all([getPaymentStatus(synapse), synapse.storage.getStorageInfo()])

  const pricePerTiBPerEpoch = storageInfo.pricing.noCDN.perTiBPerEpoch
  const storageTiB = carSizeBytes / Number(SIZE_CONSTANTS.TiB)

  // Calculate requirements
  const required = calculateRequiredAllowances(carSizeBytes, pricePerTiBPerEpoch)
  const totalDepositNeeded = withBuffer(required.lockupAllowance)

  const result: PaymentCapacityCheck = {
    canUpload: true,
    storageTiB,
    required,
    issues: {},
    suggestions: [],
  }

  // Only check deposit
  if (status.depositedAmount < totalDepositNeeded) {
    result.canUpload = false
    result.issues.insufficientDeposit = totalDepositNeeded - status.depositedAmount
    const depositNeeded = ethers.formatUnits(totalDepositNeeded - status.depositedAmount, 18)
    result.suggestions.push(`Deposit at least ${depositNeeded} USDFC`)
  }

  // Add warning if approaching deposit limit
  const totalLockupAfter = status.currentAllowances.lockupUsed + required.lockupAllowance
  if (totalLockupAfter > withoutBuffer(status.depositedAmount) && result.canUpload) {
    const additionalDeposit = ethers.formatUnits(withBuffer(totalLockupAfter) - status.depositedAmount, 18)
    result.suggestions.push(`Consider depositing ${additionalDeposit} more USDFC for safety margin`)
  }

  return result
}
