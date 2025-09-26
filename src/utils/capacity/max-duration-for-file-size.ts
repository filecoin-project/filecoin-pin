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
  rateDurationDays: number
  lockupDurationDays: number
} {
  // fileSize is in bytes. Convert bytes -> TiB as a safe number, then compute rate.
  const tib = ratioToNumber(fileSize, SIZE_CONSTANTS.TiB)
  const requiredRateAllowance = calculateRate(pricePerTiBPerEpoch, tib)

  // Calculate duration based on rate allowance
  const rateDurationDays =
    rateAllowance > 0n && requiredRateAllowance > 0n ? calculateRatioAsNumber(rateAllowance, requiredRateAllowance) : 0

  // Calculate duration based on lockup allowance (10-day max)
  const epochsPerDay = TIME_CONSTANTS.EPOCHS_PER_DAY
  const maxLockupEpochs = 10n * epochsPerDay
  const requiredPerDay = requiredRateAllowance * epochsPerDay

  let lockupDurationDays = 0
  if (lockupAllowance >= requiredRateAllowance * maxLockupEpochs && requiredRateAllowance > 0n) {
    lockupDurationDays = 10
  } else if (lockupAllowance > 0n && requiredPerDay > 0n) {
    lockupDurationDays = Math.min(10, calculateRatioAsNumber(lockupAllowance, requiredPerDay))
  }

  const maxDurationDays = Math.min(rateDurationDays, lockupDurationDays)
  const limitingFactor = rateDurationDays < lockupDurationDays ? 'rate' : 'lockup'

  return {
    maxDurationDays,
    limitingFactor,
    rateDurationDays,
    lockupDurationDays,
  }
}
