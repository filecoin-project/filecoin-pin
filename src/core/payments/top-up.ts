import type { Synapse } from '@filoz/synapse-sdk'
import type { Logger } from 'pino'
import { formatUSDFC } from '../utils/index.js'
import {
  calculatePieceUploadRequirements,
  computeAdjustmentForExactDaysWithPiece,
  computeTopUpForDuration,
  depositUSDFC,
  getPaymentStatus,
} from './index.js'
import type { PaymentStatus, TopUpCalculation, TopUpReasonCode, TopUpResult } from './types.js'

/**
 * Format a human-readable message for a top-up calculation
 *
 * @param calc - Top-up calculation result
 * @returns Human-readable message explaining the top-up requirement
 */
export function formatTopUpReason(calc: TopUpCalculation): string {
  if (calc.requiredTopUp === 0n) {
    return 'No top-up required'
  }

  switch (calc.reasonCode) {
    case 'piece-upload':
      return 'Required top-up for file upload (lockup requirement)'
    case 'required-runway':
      return `Required top-up for ${calc.calculation.minStorageDays} days of storage`
    case 'required-runway-plus-upload':
      return `Required top-up for ${calc.calculation.minStorageDays} days of storage (including upcoming upload)`
    default:
      return 'Required top-up'
  }
}

/**
 * Calculate required top-up for a specific storage scenario
 *
 * This function determines how much USDFC needs to be deposited to meet
 * the specified storage requirements, taking into account current usage
 * and the size of any upcoming upload.
 *
 * @param status - Current payment status
 * @param options - Storage requirements
 * @returns Top-up calculation with reasoning
 */
export function calculateRequiredTopUp(
  status: PaymentStatus,
  options: {
    minStorageDays?: number | undefined
    pieceSizeBytes?: number | undefined
    pricePerTiBPerEpoch?: bigint | undefined
  }
): TopUpCalculation {
  const { minStorageDays = 0, pieceSizeBytes, pricePerTiBPerEpoch } = options
  const rateUsed = status.currentAllowances.rateUsed ?? 0n
  const lockupUsed = status.currentAllowances.lockupUsed ?? 0n

  let requiredTopUp = 0n
  let reasonCode: TopUpReasonCode = 'none'

  // Calculate piece upload requirements if we have piece info
  let pieceUploadTopUp = 0n
  if (pieceSizeBytes != null && pieceSizeBytes > 0 && pricePerTiBPerEpoch != null) {
    const uploadRequirements = calculatePieceUploadRequirements(status, pieceSizeBytes, pricePerTiBPerEpoch)
    if (uploadRequirements.insufficientDeposit > 0n) {
      pieceUploadTopUp = uploadRequirements.insufficientDeposit
    }
  }

  // Calculate runway requirements if specified
  let runwayTopUp = 0n
  let isRunwayWithUpload = false
  if (minStorageDays > 0) {
    if (rateUsed === 0n && pieceSizeBytes != null && pieceSizeBytes > 0 && pricePerTiBPerEpoch != null) {
      // New piece upload with runway requirement
      const { delta } = computeAdjustmentForExactDaysWithPiece(
        status,
        minStorageDays,
        pieceSizeBytes,
        pricePerTiBPerEpoch
      )
      runwayTopUp = delta
      isRunwayWithUpload = true
    } else {
      // Existing usage with runway requirement
      const { topUp } = computeTopUpForDuration(status, minStorageDays)
      runwayTopUp = topUp
    }
  }

  // Determine the final top-up requirement (take the maximum of file upload and runway needs)
  if (runwayTopUp > pieceUploadTopUp) {
    requiredTopUp = runwayTopUp
    reasonCode = isRunwayWithUpload ? 'required-runway-plus-upload' : 'required-runway'
  } else if (pieceUploadTopUp > 0n) {
    requiredTopUp = pieceUploadTopUp
    reasonCode = 'piece-upload'
  }

  return {
    requiredTopUp,
    reasonCode,
    calculation: {
      minStorageDays,
      pieceSizeBytes,
      pricePerTiBPerEpoch,
      currentRateUsed: rateUsed,
      currentLockupUsed: lockupUsed,
      currentDeposited: status.filecoinPayBalance,
    },
  }
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

  // Check if deposit would exceed maximum balance if specified
  if (balanceLimit != null && balanceLimit >= 0n) {
    // Check if current balance already equals or exceeds limit
    if (currentStatus.filecoinPayBalance >= balanceLimit) {
      const message = `Current balance (${formatUSDFC(currentStatus.filecoinPayBalance)}) already equals or exceeds the configured balance limit (${formatUSDFC(balanceLimit)}). No additional deposits will be made.`
      logger?.warn(`${message}`)
      return {
        success: true,
        deposited: 0n,
        message,
        warnings,
      }
    } else {
      // Check if required top-up would exceed the limit
      const projectedBalance = currentStatus.filecoinPayBalance + topUpAmount
      if (projectedBalance > balanceLimit) {
        // Calculate the maximum allowed top-up that won't exceed the limit
        const maxAllowedTopUp = balanceLimit - currentStatus.filecoinPayBalance
        if (maxAllowedTopUp > 0n) {
          const warning = `Required top-up (${formatUSDFC(topUpAmount)}) would exceed the configured balance limit (${formatUSDFC(balanceLimit)}). Reducing to ${formatUSDFC(maxAllowedTopUp)}.`
          logger?.warn(`${warning}`)
          warnings.push(warning)
          topUpAmount = maxAllowedTopUp
        } else {
          return {
            success: true,
            deposited: 0n,
            message: 'Cannot deposit - would exceed balance limit',
            warnings,
          }
        }
      }
    }
  }

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
