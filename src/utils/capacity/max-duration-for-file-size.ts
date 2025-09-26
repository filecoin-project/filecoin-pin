import { TIME_CONSTANTS } from '@filoz/synapse-sdk'
import type { StorageAllowances } from '../../synapse/payments.js'
import { calculateRate, calculateRatioAsNumber, ratioToNumber } from '../numbers/safe-scaling.js'
import { SIZE_CONSTANTS } from './units.js'

export interface MaxDurationForFileSizeParams extends Omit<StorageAllowances, 'storageCapacityTiB'> {
  /**
   * The size of the file in bytes
   */
  fileSize: bigint

  /**
   * The price per TiB per epoch (USDFC/TiB/epoch)
   */
  pricePerTiBPerEpoch: bigint
}

/**
 * Calculate how many days a specific file size can be supported by the current
 * rate and lockup allowances.
 *
 * - Rate-limited duration is unbounded by lockup and equals rateAllowance / requiredRate.
 * - Lockup-limited duration is capped at 10 days and equals
 *   lockupAllowance / (requiredRate × epochsPerDay), unless lockup covers 10 full days.
 *
 * Precision: Uses safe-scaling utilities to avoid precision loss converting bigints.
 */
export function calculateMaxDurationForFileSize({
  fileSize,
  rateAllowance,
  lockupAllowance,
  pricePerTiBPerEpoch,
}: MaxDurationForFileSizeParams): {
  maxDurationDays: number
  limitingFactor: 'rate' | 'lockup'
} {
  // fileSize is in bytes. Convert bytes -> TiB as a safe number, then compute rate.
  const tib = ratioToNumber(fileSize, SIZE_CONSTANTS.TiB)
  const requiredRateAllowance = calculateRate(pricePerTiBPerEpoch, tib)

  // Calculate duration based on rate allowance
  const rateBasedDuration = rateAllowance > 0n ? calculateRatioAsNumber(rateAllowance, requiredRateAllowance) : 0

  // Calculate duration based on lockup allowance (10-day max)
  const epochsPerDay = TIME_CONSTANTS.EPOCHS_PER_DAY
  const maxLockupEpochs = 10n * epochsPerDay
  const requiredPerDay = requiredRateAllowance * epochsPerDay

  const lockupBasedDuration =
    lockupAllowance >= requiredRateAllowance * maxLockupEpochs
      ? 10
      : calculateRatioAsNumber(lockupAllowance, requiredPerDay)

  const maxDurationDays = Math.min(rateBasedDuration, lockupBasedDuration)
  const limitingFactor = rateBasedDuration < lockupBasedDuration ? 'rate' : 'lockup'

  return {
    maxDurationDays,
    limitingFactor,
  }
}
