// import {  } from '@filoz/synapse-sdk'
import { calculateRate, ratioToNumber } from '../numbers/safe-scaling.js'
import { SIZE_CONSTANTS } from './units.js'

export interface MaxDurationForFileSizeParams {
  /**
   * The size of the file in bytes
   */
  fileSize: bigint

  /**
   * The rate allowance in its smallest unit
   */
  rateAllowance: bigint

  /**
   * The lockup allowance in its smallest unit
   */
  lockupAllowance: bigint
  /**
   * The price per TiB per epoch
   */
  pricePerTiBPerEpoch: bigint
}

/**
 * Calculate how many days a specific file size can be supported
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
  const rateBasedDuration = rateAllowance > 0n ? Number(rateAllowance) / Number(requiredRateAllowance) : 0

  // Calculate duration based on lockup allowance (10-day max)
  const lockupBasedDuration =
    lockupAllowance >= requiredRateAllowance * BigInt(10 * 2880)
      ? 10
      : Number(lockupAllowance) / Number(requiredRateAllowance * BigInt(2880))

  const maxDurationDays = Math.min(rateBasedDuration, lockupBasedDuration)
  const limitingFactor = rateBasedDuration < lockupBasedDuration ? 'rate' : 'lockup'

  return {
    maxDurationDays,
    limitingFactor,
  }
}
