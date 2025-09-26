import { TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { calculateActualCapacity } from '../../synapse/payments.js'
import { scaleNumberRatio } from '../numbers/safe-scaling.js'

export type AllowanceType = 'rate' | 'lockup'

interface CapacityForDurationOptions {
  allowanceType?: AllowanceType
}

/**
 * Calculate storage capacity for a given duration.
 *
 * - When `allowanceType === 'rate'`, the allowance is interpreted as a
 *   per-epoch budget (USDFC/epoch) and the resulting capacity is independent
 *   of the requested duration.
 * - When `allowanceType === 'lockup'`, the allowance represents a total
 *   escrow amount (USDFC) that must cover the full duration. For sub-epoch
 *   durations the calculation rounds up to a minimum of one epoch.
 *
 * @param allowance - Rate allowance (USDFC/epoch) or lockup allowance (USDFC)
 * @param pricePerTiBPerEpoch - Current pricing from storage service (USDFC/TiB/epoch)
 * @param duration - Duration in days (can be fractional)
 * @param options - Calculation options, including allowance type (default: 'lockup')
 * @returns Storage capacity in TiB for the given duration
 */
export function calculateCapacityForDuration(
  allowance: bigint,
  pricePerTiBPerEpoch: bigint,
  duration: number,
  options: CapacityForDurationOptions = {}
): number {
  const { allowanceType = 'lockup' } = options

  if (allowance <= 0n || pricePerTiBPerEpoch <= 0n || duration <= 0) {
    return 0
  }

  if (allowanceType === 'rate') {
    // Rate allowance is expressed per epoch, so the supported capacity is
    // independent of the requested duration. We simply return the per-epoch
    // capacity derived from the allowance.
    return calculateActualCapacity(allowance, pricePerTiBPerEpoch)
  }

  // Lockup allowance is a total budget that must cover the full duration.
  // For sub-epoch durations, round up to a minimum of 1 epoch to avoid
  // under-reporting capacity.
  if (duration <= 1 / Number(TIME_CONSTANTS.EPOCHS_PER_DAY)) {
    const epochsInDuration = 1n
    const totalCostForDuration = pricePerTiBPerEpoch * epochsInDuration
    return calculateActualCapacity(allowance, totalCostForDuration)
  }

  // Use safe scaling to convert fractional days to epochs without precision loss
  const { scaled: scaledDuration, scale } = scaleNumberRatio(duration, 1)
  let epochsInDuration = (scaledDuration * TIME_CONSTANTS.EPOCHS_PER_DAY) / scale
  if (epochsInDuration <= 0n) {
    epochsInDuration = 1n
  }
  const totalCostForDuration = pricePerTiBPerEpoch * epochsInDuration
  return calculateActualCapacity(allowance, totalCostForDuration)
}
