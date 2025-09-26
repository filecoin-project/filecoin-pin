import { SIZE_CONSTANTS } from '@filoz/synapse-sdk'
import type { ServiceApprovalStatus } from '../../synapse/payments.js'
import { calculateCapacityForDuration } from './capacity-for-duration.js'

/**
 * Calculate the maximum file size that can be uploaded with current allowances.
 *
 * - Rate limit: Converts rateAllowance to TiB capacity (unbounded by time).
 * - Lockup limit: Converts lockupAllowance to TiB capacity for 10 days.
 *
 * Returns sizes in both bytes and TiB, as well as which allowance limits the upload.
 */
export function calculateMaxUploadableFileSize({
  rateAllowance,
  lockupAllowance,
  pricePerTiBPerEpoch,
}: ServiceApprovalStatus & { pricePerTiBPerEpoch: bigint }): {
  maxSizeBytes: number
  maxSizeTiB: number
  limitingFactor: 'rate' | 'lockup' | 'both'
  rateLimitTiB: number
  lockupLimitTiB: number
} {
  // Calculate max TiB from rate allowance (10-day minimum)
  const rateLimitTiB = calculateCapacityForDuration(rateAllowance, pricePerTiBPerEpoch, 10)

  // Calculate max TiB from lockup allowance (10-day minimum)
  const lockupLimitTiB = calculateCapacityForDuration(lockupAllowance, pricePerTiBPerEpoch, 10)

  // The limiting factor is the smaller of the two
  const maxSizeTiB = Math.min(rateLimitTiB, lockupLimitTiB)
  const maxSizeBytes = maxSizeTiB * Number(SIZE_CONSTANTS.TiB)

  let limitingFactor: 'rate' | 'lockup' | 'both'
  if (Math.abs(rateLimitTiB - lockupLimitTiB) < 0.0001) {
    limitingFactor = 'both'
  } else if (rateLimitTiB < lockupLimitTiB) {
    limitingFactor = 'rate'
  } else {
    limitingFactor = 'lockup'
  }

  return {
    maxSizeBytes,
    maxSizeTiB,
    limitingFactor,
    rateLimitTiB,
    lockupLimitTiB,
  }
}
