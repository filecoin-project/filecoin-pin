/**
 * Payment-related constants for Filecoin Onchain Cloud
 *
 * This module contains all constants used in payment operations including
 * decimals, lockup periods, buffer configurations, and pricing minimums.
 */

import { TIME_CONSTANTS } from '@filoz/synapse-core/utils'
import { maxUint256, parseEther } from 'viem'

/**
 * USDFC token decimals (ERC20 standard)
 */
export const USDFC_DECIMALS = 18

/**
 * Minimum FIL balance required for gas fees
 */
export const MIN_FIL_FOR_GAS = parseEther('0.1')

/**
 * Default lockup period required by WarmStorage (in days)
 */
export const DEFAULT_LOCKUP_DAYS = Number(TIME_CONSTANTS.DEFAULT_LOCKUP_DAYS)

/**
 * Maximum allowances for trusted WarmStorage service
 * Using MaxUint256 which MetaMask displays as "Unlimited"
 */
export const MAX_RATE_ALLOWANCE = maxUint256
export const MAX_LOCKUP_ALLOWANCE = maxUint256

/**
 * Maximum precision scale used when converting small TiB (as a float) to integer(BigInt) math
 */
export const STORAGE_SCALE_MAX = 10_000_000
export const STORAGE_SCALE_MAX_BI = BigInt(STORAGE_SCALE_MAX)
