/**
 * Floor pricing calculations for WarmStorage
 *
 * This module handles the minimum rate per piece (floor price) logic.
 * The floor price ensures that small files meet the minimum cost requirement
 * of 0.06 USDFC per 30 days, regardless of their actual size.
 *
 * Implementation follows the pattern from synapse-sdk PR #375:
 * 1. Calculate base cost from piece size
 * 2. Calculate floor cost (minimum per piece)
 * 3. Return max(base cost, floor cost)
 */

import { TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { DEFAULT_LOCKUP_DAYS, FLOOR_PRICE_DAYS, FLOOR_PRICE_PER_30_DAYS } from './constants.js'
import type { StorageAllowances } from './types.js'

/**
 * Calculate floor-adjusted allowances for a piece
 *
 * This function applies the floor pricing (minimum rate per piece) to ensure
 * that small files meet the minimum cost requirement.
 *
 * Example usage:
 * ```typescript
 * const storageInfo = await synapse.storage.getStorageInfo()
 * const pricing = storageInfo.pricing.noCDN.perTiBPerEpoch
 *
 * // For a small file (1 KB)
 * const allowances = calculateFloorAdjustedAllowances(1024, pricing)
 * // Will return floor price allowances (0.06 USDFC per 30 days)
 *
 * // For a large file (10 GiB)
 * const allowances = calculateFloorAdjustedAllowances(10 * 1024 * 1024 * 1024, pricing)
 * // Will return calculated allowances based on size (floor doesn't apply)
 * ```
 *
 * @param baseAllowances - Base allowances calculated from piece size
 * @returns Floor-adjusted allowances for the piece
 */
export function applyFloorPricing(baseAllowances: StorageAllowances): StorageAllowances {
  // Calculate floor rate per epoch
  // floor price is per 30 days, so we divide by (30 days * epochs per day)
  const epochsInFloorPeriod = BigInt(FLOOR_PRICE_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY
  const floorRateAllowance = FLOOR_PRICE_PER_30_DAYS / epochsInFloorPeriod

  // Calculate floor lockup (floor rate * lockup period)
  const epochsInLockupDays = BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY
  const floorLockupAllowance = floorRateAllowance * epochsInLockupDays

  // Apply floor pricing: use max of base and floor
  const rateAllowance =
    baseAllowances.rateAllowance > floorRateAllowance ? baseAllowances.rateAllowance : floorRateAllowance

  const lockupAllowance =
    baseAllowances.lockupAllowance > floorLockupAllowance ? baseAllowances.lockupAllowance : floorLockupAllowance

  return {
    rateAllowance,
    lockupAllowance,
    storageCapacityTiB: baseAllowances.storageCapacityTiB,
  }
}

/**
 * Get the floor pricing allowances (minimum cost regardless of size)
 *
 * @returns Floor price allowances
 */
export function getFloorAllowances(): StorageAllowances {
  const epochsInFloorPeriod = BigInt(FLOOR_PRICE_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY
  const rateAllowance = FLOOR_PRICE_PER_30_DAYS / epochsInFloorPeriod

  const epochsInLockupDays = BigInt(DEFAULT_LOCKUP_DAYS) * TIME_CONSTANTS.EPOCHS_PER_DAY
  const lockupAllowance = rateAllowance * epochsInLockupDays

  return {
    rateAllowance,
    lockupAllowance,
    storageCapacityTiB: 0, // Floor price is not size-based
  }
}
