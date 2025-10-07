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
  getPaymentStatus,
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
