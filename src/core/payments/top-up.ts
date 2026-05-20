import type { Synapse } from '@filoz/synapse-sdk'
import type { Logger } from 'pino'
import { formatUSDFC } from '../utils/index.js'
import { depositUSDFC, getPaymentStatus } from './index.js'
import type { TopUpResult } from './types.js'

/**
 * Result of clamping a requested deposit against a balance limit.
 *
 * - `passthrough`: limit is undefined or unreached; deposit equals requested
 * - `already-at-limit`: current balance already meets/exceeds limit; deposit is 0n
 * - `clamped`: deposit was reduced to the largest amount that doesn't exceed limit
 */
export interface ClampDepositResult {
  deposit: bigint
  reason: 'passthrough' | 'already-at-limit' | 'clamped'
  message?: string
}

/**
 * Pure helper: clamp a requested deposit so the resulting balance does not exceed `limit`.
 *
 * @param currentBalance - Current Filecoin Pay balance
 * @param requested - Requested deposit amount (must be > 0n for clamping to apply)
 * @param limit - Maximum allowed post-deposit balance; undefined means no limit
 */
export function clampDepositToLimit(currentBalance: bigint, requested: bigint, limit?: bigint): ClampDepositResult {
  if (limit == null || limit < 0n || requested <= 0n) {
    return { deposit: requested, reason: 'passthrough' }
  }
  if (currentBalance >= limit) {
    return {
      deposit: 0n,
      reason: 'already-at-limit',
      message: `Current balance (${formatUSDFC(currentBalance)}) already equals or exceeds the configured balance limit (${formatUSDFC(limit)}). No additional deposits will be made.`,
    }
  }
  if (currentBalance + requested > limit) {
    const maxAllowed = limit - currentBalance
    return {
      deposit: maxAllowed,
      reason: 'clamped',
      message: `Required top-up (${formatUSDFC(requested)}) would exceed the configured balance limit (${formatUSDFC(limit)}). Reducing to ${formatUSDFC(maxAllowed)}.`,
    }
  }
  return { deposit: requested, reason: 'passthrough' }
}

/**
 * Execute a top-up operation with balance limit checking
 *
 * This function handles the complete top-up process including:
 * - Checking if top-up is needed
 * - Validating against balance limits
 * - Executing the deposit transaction
 * - Providing detailed feedback
 *
 * @param synapse - Initialized Synapse instance
 * @param topUpAmount - Amount of USDFC to deposit
 * @param options - Options for top-up execution
 * @returns Top-up execution result
 */
export async function executeTopUp(
  synapse: Synapse,
  topUpAmount: bigint,
  options: {
    balanceLimit?: bigint | undefined
    logger?: Logger | undefined
  } = {}
): Promise<TopUpResult> {
  const { balanceLimit, logger } = options
  const warnings: string[] = []

  if (topUpAmount <= 0n) {
    return {
      success: true,
      deposited: 0n,
      message: 'No deposit required - sufficient balance available',
      warnings,
    }
  }

  // Get current status for limit checking
  const currentStatus = await getPaymentStatus(synapse)

  const clamp = clampDepositToLimit(currentStatus.filecoinPayBalance, topUpAmount, balanceLimit)
  if (clamp.reason === 'already-at-limit') {
    logger?.warn(clamp.message)
    return { success: true, deposited: 0n, message: clamp.message ?? '', warnings }
  }
  if (clamp.reason === 'clamped' && clamp.message != null) {
    logger?.warn(clamp.message)
    warnings.push(clamp.message)
  }
  topUpAmount = clamp.deposit

  // Ensure wallet has sufficient USDFC for the deposit
  if (currentStatus.walletUsdfcBalance < topUpAmount) {
    const message = `Insufficient USDFC in wallet for deposit. Needed ${formatUSDFC(topUpAmount)}, available ${formatUSDFC(currentStatus.walletUsdfcBalance)}.`
    logger?.warn(`${message}`)
    return {
      success: false,
      deposited: 0n,
      message,
      warnings,
    }
  }

  try {
    // Execute the deposit
    const result = await depositUSDFC(synapse, topUpAmount)

    // Verify the deposit was successful
    const newStatus = await getPaymentStatus(synapse)
    const depositDifference = newStatus.filecoinPayBalance - currentStatus.filecoinPayBalance

    let message = ''
    if (depositDifference > 0n) {
      message = `Deposit verified: ${formatUSDFC(depositDifference)} USDFC added to Filecoin Pay`
    } else {
      message = 'Deposit transaction submitted but not yet reflected in balance'
      warnings.push('Transaction may take a moment to process')
    }

    return {
      success: true,
      deposited: depositDifference,
      transactionHash: result.depositTx,
      message,
      warnings,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      deposited: 0n,
      message: `Deposit failed: ${errorMessage}`,
      warnings,
    }
  }
}
