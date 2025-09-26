import { TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { calculateActualCapacity, getStorageScale } from '../../synapse/payments.js'

/**
 * Calculate storage capacity for a given duration.
 *
 * For sub-epoch durations, rounds up to a minimum of 1 epoch to ensure
 * meaningful capacity. For longer durations, uses adaptive scaling to
 * prevent precision loss.
 *
 * @param allowance - Current rate/lockup allowance in its smallest unit (USDFC/epoch)
 * @param pricePerTiBPerEpoch - Current pricing from storage service (USDFC/TiB/epoch)
 * @param duration - Duration in days (can be fractional)
 * @returns Storage capacity in TiB for the given duration
 */
export function calculateCapacityForDuration(allowance: bigint, pricePerTiBPerEpoch: bigint, duration: number): number {
  // For very small durations (less than or equal to 1 epoch), use direct calculation
  if (duration <= 1 / Number(TIME_CONSTANTS.EPOCHS_PER_DAY)) {
    const epochsInDuration = 1n // Minimum 1 epoch
    const totalCostForDuration = pricePerTiBPerEpoch * epochsInDuration
    return calculateActualCapacity(allowance, totalCostForDuration)
  }

  // Use adaptive scaling to handle fractional durations and precision issues
  const scale = getStorageScale(duration)
  const scaledDuration = Math.floor(duration * scale)
  const epochsInDuration = (BigInt(scaledDuration) * TIME_CONSTANTS.EPOCHS_PER_DAY) / BigInt(scale)
  const totalCostForDuration = pricePerTiBPerEpoch * epochsInDuration
  return calculateActualCapacity(allowance, totalCostForDuration)
}
