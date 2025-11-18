/**
 * Payment-related constants for Filecoin Onchain Cloud
 *
 * This module contains all constants used in payment operations including
 * decimals, lockup periods, buffer configurations, and pricing minimums.
 */

import { ethers } from 'ethers'

/**
 * USDFC token decimals (ERC20 standard)
 */
export const USDFC_DECIMALS = 18

/**
 * Minimum FIL balance required for gas fees
 */
export const MIN_FIL_FOR_GAS = ethers.parseEther('0.1')

/**
 * Default lockup period required by WarmStorage (in days)
 */
export const DEFAULT_LOCKUP_DAYS = 30

/**
 * Floor price per piece for WarmStorage (minimum cost regardless of size)
 * This is 0.06 USDFC per 30 days per piece
 */
export const FLOOR_PRICE_PER_30_DAYS = ethers.parseUnits('0.06', USDFC_DECIMALS)

/**
 * Number of days the floor price covers
 */
export const FLOOR_PRICE_DAYS = 30

/**
 * Maximum allowances for trusted WarmStorage service
 * Using MaxUint256 which MetaMask displays as "Unlimited"
 */
export const MAX_RATE_ALLOWANCE = ethers.MaxUint256
export const MAX_LOCKUP_ALLOWANCE = ethers.MaxUint256

/**
 * Standard buffer configuration (10%) used across deposit/lockup calculations
 */
export const BUFFER_NUMERATOR = 11n
export const BUFFER_DENOMINATOR = 10n

/**
 * Maximum precision scale used when converting small TiB (as a float) to integer(BigInt) math
 */
export const STORAGE_SCALE_MAX = 10_000_000
export const STORAGE_SCALE_MAX_BI = BigInt(STORAGE_SCALE_MAX)

/** PDP Leaf Size - the payment rate is based on `rawSize` bytes rounded up to the next multiple of 32.
 *
 * @see - https://github.com/FilOzone/synapse-sdk/issues/339#issue-3539254596
 */
export const PDP_LEAF_SIZE = 32

/**
 * Pad raw size to the next multiple of 32 bytes
 *
 * @param rawSizeBytes - The actual size in bytes
 * @returns Padded size (next multiple of 32)
 */
export function padSizeToPDPLeaves(rawSizeBytes: number): number {
  return Math.ceil(rawSizeBytes / PDP_LEAF_SIZE) * PDP_LEAF_SIZE
}
