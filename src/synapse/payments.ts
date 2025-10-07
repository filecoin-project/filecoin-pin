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

import { type Synapse, TOKENS } from '@filoz/synapse-sdk'
import { checkFILBalance, checkUSDFCBalance, type PaymentStatus } from '../core/payments/index.js'

export type {
  PaymentCapacityCheck,
  PaymentStatus,
  ServiceApprovalStatus,
  StorageAllowances,
} from '../core/payments/index.js'
export {
  BUFFER_DENOMINATOR,
  BUFFER_NUMERATOR,
  calculateActualCapacity,
  calculateDepositCapacity,
  calculateRequiredAllowances,
  calculateStorageAllowances,
  calculateStorageFromUSDFC,
  calculateStorageRunway,
  checkAllowances,
  checkAndSetAllowances,
  checkFILBalance,
  checkUSDFCBalance,
  computeAdjustmentForExactDays,
  computeAdjustmentForExactDeposit,
  computeTopUpForDuration,
  getStorageScale,
  STORAGE_SCALE_MAX,
  setMaxAllowances,
  setServiceApprovals,
  USDFC_DECIMALS,
  validatePaymentCapacity,
  withBuffer,
  withoutBuffer,
} from '../core/payments/index.js'

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
