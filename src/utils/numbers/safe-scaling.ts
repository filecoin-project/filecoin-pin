// /**
//  * Maximum precision scale used for bigint-first scaling operations
//  */
// export const STORAGE_SCALE_MAX = 10_000_000
// const STORAGE_SCALE_MAX_BI = BigInt(STORAGE_SCALE_MAX)

// function getScale(value: bigint | number): bigint {
//   if (typeof value === 'bigint') {
//     // if its a bigint, we don't want to return STORAGE_SCALE_MAX_BI always, we want to return a scaling factor that can reduce it to a number that is less than or equal to Number.MAX_SAFE_INTEGER
//     const maxScaleBySafe = Math.floor(Number.MAX_SAFE_INTEGER / Number(value))
//     return BigInt(Math.max(1, Math.min(STORAGE_SCALE_MAX, maxScaleBySafe)))
//   }
//   if (value <= 0) return 1n
//   const maxScaleBySafe = Math.floor(Number.MAX_SAFE_INTEGER / value)
//   return BigInt(Math.max(1, Math.min(STORAGE_SCALE_MAX, maxScaleBySafe)))
// }

// /**
//  * Generic bigint scaler for a rational num/den.
//  * Returns floor(num * scale / den) and the scale used.
//  * @param num - The numerator; represents the value to be scaled. Must be > 0n
//  * @param den - The denominator; represents the unit of the value to be scaled. Must be > 0n
//  * @returns The scaled value, the scale used, and the scale factor
//  */
// export function scaleRatio(num: bigint, den: bigint): { scaled: bigint; scale: bigint; scaleFactor: bigint } {
//   if (den <= 0n) throw new Error('den must be > 0n')
//   if (num <= 0n) return { scaled: 0n, scale: 1n, scaleFactor: 0n }
//   const scale = getScale(num) // bigint can handle large intermediates; no need to adapt for overflow
//   const scaled = (num * scale) / den // truncation by integer division
//   return { scaled, scale, scaleFactor: scaled / scale }
// }

// /**
//  * If you need a JS number for UI after scaling (bounded & safe):
//  * - Converts only the bounded `scaled` and `scale` to number.
//  * - Throws if whole part would exceed MAX_SAFE_INTEGER when decimals=0.
//  */
// export function scaledToNumber(scaled: bigint, scale: bigint): number {
//   if (scale <= 0n) throw new Error('scale must be > 0n')
//   // scaled < scale * STORAGE_SCALE_MAX by construction; both are <= ~1e7 cap
//   return Number(scaled) / Number(scale)
// }

/**
 * Safe scaling utilities for high-precision arithmetic operations.
 *
 * This module provides utilities to safely perform ratio calculations that would
 * otherwise overflow JavaScript's Number.MAX_SAFE_INTEGER or lose precision.
 * All functions assume non-negative inputs for simplicity and performance.
 *
 * @example Basic usage
 * ```typescript
 * // Safe ratio calculation
 * const ratio = calculateRatioAsNumber(depositedAmount, requiredDeposit)
 * const actualGiB = potentialGiB * ratio
 *
 * // Safe rate calculation
 * const rate = calculateRate(pricePerTiB, storageAmount)
 * ```
 */

export const STORAGE_SCALE_MAX = 10_000_000
const STORAGE_SCALE_MAX_BI = BigInt(STORAGE_SCALE_MAX)
const MAX_SAFE_BI = BigInt(Number.MAX_SAFE_INTEGER)

/**
 * Rounding modes for division operations.
 */
export type Rounding = 'floor' | 'ceil' | 'trunc' | 'half-up' | 'half-down' | 'half-even'

// ============================================================================
// Input Validation Helpers
// ============================================================================

function assertNonNegativeBigint(name: string, value: bigint): void {
  if (value < 0n) throw new Error(`${name} must be >= 0, got ${value}`)
}

function assertNonNegativeNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite number >= 0, got ${value}`)
  }
}

function assertPositiveBigint(name: string, value: bigint): void {
  if (value <= 0n) throw new Error(`${name} must be > 0, got ${value}`)
}

// ============================================================================
// Core Mathematical Functions
// ============================================================================

/**
 * Performs integer division with configurable rounding.
 * Optimized for non-negative inputs only.
 *
 * @param numerator - Numerator (must be >= 0)
 * @param denominator - Denominator (must be > 0)
 * @param mode - Rounding mode (default: 'half-up')
 * @returns Rounded quotient
 *
 * @example
 * ```typescript
 * divRound(7n, 3n, 'half-up')   // 2n
 * divRound(7n, 3n, 'floor')     // 2n
 * divRound(7n, 3n, 'ceil')      // 3n
 * ```
 */
export function divRound(numerator: bigint, denominator: bigint, mode: Rounding = 'half-up'): bigint {
  assertPositiveBigint('denominator', denominator)
  assertNonNegativeBigint('numerator', numerator)

  if (mode === 'trunc' || mode === 'floor') return numerator / denominator
  if (mode === 'ceil') return (numerator + denominator - 1n) / denominator

  // Half-rounding modes (simplified for non-negative inputs)
  const quotient = numerator / denominator
  const remainder = numerator % denominator
  if (remainder === 0n) return quotient

  const twiceRemainder = 2n * remainder
  if (mode === 'half-up') return twiceRemainder >= denominator ? quotient + 1n : quotient
  if (mode === 'half-down') return twiceRemainder > denominator ? quotient + 1n : quotient

  // half-even (banker's rounding)
  if (twiceRemainder > denominator) return quotient + 1n
  if (twiceRemainder < denominator) return quotient
  // Tie: round to even
  return quotient % 2n === 0n ? quotient : quotient + 1n
}

/**
 * Computes an appropriate scale for a value to prevent overflow while maximizing precision.
 *
 * @param value - The value to scale (must be >= 0)
 * @returns A scale factor that keeps value * scale within safe integer range
 *
 * @internal
 */
export function getScale(value: bigint | number): bigint {
  if (typeof value === 'bigint') {
    assertNonNegativeBigint('value', value)
    if (value === 0n) return 1n
    if (value >= MAX_SAFE_BI) return 1n // Too large, avoid scaling up

    const maxScaleByValue = MAX_SAFE_BI / value
    return maxScaleByValue >= STORAGE_SCALE_MAX_BI ? STORAGE_SCALE_MAX_BI : maxScaleByValue
  }

  assertNonNegativeNumber('value', value)
  if (value === 0) return 1n

  const maxScaleByValue = Math.floor(Number.MAX_SAFE_INTEGER / value)
  const clampedScale = Math.max(1, Math.min(STORAGE_SCALE_MAX, maxScaleByValue))
  return BigInt(clampedScale)
}

/**
 * Chooses a scale for a ratio that ensures safe conversion to Number.
 *
 * @param numerator - Numerator (must be >= 0)
 * @param denominator - Denominator (must be > 0)
 * @returns Scale that keeps both the scaled result and scale itself within Number.MAX_SAFE_INTEGER
 *
 * @internal
 */
export function chooseScaleForRatio(numerator: bigint, denominator: bigint): bigint {
  assertNonNegativeBigint('numerator', numerator)
  assertPositiveBigint('denominator', denominator)
  if (numerator === 0n) return 1n

  // Start with maximum possible scale
  let scale = MAX_SAFE_BI

  // Bound by the scaled result: (numerator * scale) / denominator <= MAX_SAFE
  // Therefore: scale <= (MAX_SAFE * denominator) / numerator
  const boundByScaledResult = (MAX_SAFE_BI * denominator) / numerator
  if (boundByScaledResult < scale) scale = boundByScaledResult

  // Cap by our global precision ceiling
  if (scale > STORAGE_SCALE_MAX_BI) scale = STORAGE_SCALE_MAX_BI
  if (scale < 1n) scale = 1n

  return scale
}

/**
 * Computes the greatest common divisor of two non-negative bigints.
 *
 * @param a - First number (must be >= 0)
 * @param b - Second number (must be >= 0)
 * @returns Greatest common divisor
 *
 * @internal
 */
export function gcd(a: bigint, b: bigint): bigint {
  assertNonNegativeBigint('a', a)
  assertNonNegativeBigint('b', b)

  while (b !== 0n) {
    const temp = b
    b = a % b
    a = temp
  }
  return a
}

/**
 * Creates an exact reduced fraction representation.
 *
 * @param numerator - Numerator (must be >= 0)
 * @param denominator - Denominator (must be > 0)
 * @returns Reduced fraction as {p, q} where gcd(p,q) = 1 and q > 0
 *
 * @example
 * ```typescript
 * const frac = ratio(6n, 9n)  // { p: 2n, q: 3n }
 * ```
 */
export function ratio(numerator: bigint, denominator: bigint): { p: bigint; q: bigint } {
  assertNonNegativeBigint('numerator', numerator)
  assertPositiveBigint('denominator', denominator)

  if (numerator === 0n) return { p: 0n, q: 1n }

  const commonDivisor = gcd(numerator, denominator)
  return { p: numerator / commonDivisor, q: denominator / commonDivisor }
}

// ============================================================================
// Main Scaling Functions
// ============================================================================

/**
 * Scales a ratio using adaptive precision based on the numerator size.
 * Best for calculations that will remain in bigint arithmetic.
 *
 * @param numerator - Numerator (must be >= 0)
 * @param denominator - Denominator (must be > 0)
 * @param rounding - Rounding mode for the division
 * @returns Scaled ratio as {scaled, scale}
 *
 * @example
 * ```typescript
 * const { scaled, scale } = scaleRatio(depositedAmount, requiredDeposit)
 * const result = (someValue * scaled) / scale
 * ```
 */
export function scaleRatio(
  numerator: bigint,
  denominator: bigint,
  rounding: Rounding = 'half-up'
): { scaled: bigint; scale: bigint } {
  assertNonNegativeBigint('numerator', numerator)
  assertPositiveBigint('denominator', denominator)

  if (numerator === 0n) return { scaled: 0n, scale: 1n }

  const scale = getScale(numerator)
  const scaled = divRound(numerator * scale, denominator, rounding)
  return { scaled, scale }
}

/**
 * Scales a ratio optimized for safe conversion to JavaScript Number.
 * Use when you plan to convert the result back to a regular number.
 *
 * @param numerator - Numerator (must be >= 0)
 * @param denominator - Denominator (must be > 0)
 * @param rounding - Rounding mode for the division
 * @returns Scaled ratio optimized for Number conversion
 *
 * @example
 * ```typescript
 * const { scaled, scale } = scaleRatioForNumber(numerator, denominator)
 * const ratio = scaledToNumber(scaled, scale)  // Won't throw due to overflow
 * ```
 */
export function scaleRatioForNumber(
  numerator: bigint,
  denominator: bigint,
  rounding: Rounding = 'half-up'
): { scaled: bigint; scale: bigint } {
  assertNonNegativeBigint('numerator', numerator)
  assertPositiveBigint('denominator', denominator)

  if (numerator === 0n) return { scaled: 0n, scale: 1n }

  const scale = chooseScaleForRatio(numerator, denominator)
  const scaled = divRound(numerator * scale, denominator, rounding)
  return { scaled, scale }
}

/**
 * Safely scales ratios involving JavaScript numbers.
 * Converts numbers to bigint with appropriate precision before scaling.
 *
 * @param numerator - Numerator as a JavaScript number (must be >= 0)
 * @param denominator - Denominator as a JavaScript number (must be > 0)
 * @param rounding - Rounding mode for the conversion
 * @returns Scaled ratio representing approximately numerator/denominator
 *
 * @example
 * ```typescript
 * const { scaled, scale } = scaleNumberRatio(1.5, 2.0)
 * const result = (someValue * scaled) / scale  // Equivalent to someValue * 0.75
 * ```
 */
export function scaleNumberRatio(
  numerator: number,
  denominator: number,
  rounding: Rounding = 'half-up'
): { scaled: bigint; scale: bigint } {
  assertNonNegativeNumber('numerator', numerator)
  assertNonNegativeNumber('denominator', denominator)
  if (denominator === 0) throw new Error('Denominator must be > 0')
  if (numerator === 0) return { scaled: 0n, scale: 1n }

  const numeratorScale = getScale(numerator)
  const denominatorScale = getScale(denominator)
  const commonScale = numeratorScale < denominatorScale ? numeratorScale : denominatorScale
  const scaleAsNumber = Number(commonScale) // Safe by construction

  // Round to nearest integer counts at the common scale
  const scaledNumerator = BigInt(Math.round(numerator * scaleAsNumber))
  let scaledDenominator = BigInt(Math.round(denominator * scaleAsNumber))
  if (scaledDenominator === 0n) {
    // ensure we never pass 0n as the divisor due to rounding tiny positives
    scaledDenominator = 1n
  }

  const scaled = divRound(scaledNumerator * commonScale, scaledDenominator, rounding)
  return { scaled, scale: commonScale }
}

// ============================================================================
// Conversion Functions
// ============================================================================

/**
 * Converts a scaled bigint ratio back to a JavaScript Number.
 * Throws an error if the conversion would lose precision or overflow.
 *
 * @param scaled - The scaled numerator (must be >= 0)
 * @param scale - The scale factor (must be > 0)
 * @returns The ratio as a JavaScript Number
 * @throws Error if conversion would be unsafe
 *
 * @example
 * ```typescript
 * const { scaled, scale } = scaleRatio(3n, 2n)
 * const ratio = scaledToNumber(scaled, scale)  // 1.5
 * ```
 */
export function scaledToNumber(scaled: bigint, scale: bigint): number {
  assertNonNegativeBigint('scaled', scaled)
  assertPositiveBigint('scale', scale)

  if (scaled > MAX_SAFE_BI) {
    throw new Error(`Scaled value ${scaled} too large for safe Number conversion`)
  }
  if (scale > MAX_SAFE_BI) {
    throw new Error(`Scale ${scale} too large for safe Number conversion`)
  }

  const result = Number(scaled) / Number(scale)
  if (!Number.isFinite(result)) {
    throw new Error('Result is not a finite number')
  }

  return result
}

/**
 * Safely converts a scaled bigint ratio to a JavaScript Number.
 * Returns null instead of throwing if the conversion would be unsafe.
 *
 * @param scaled - The scaled numerator (must be >= 0)
 * @param scale - The scale factor (must be > 0)
 * @returns The ratio as a Number, or null if conversion is unsafe
 *
 * @example
 * ```typescript
 * const ratio = tryScaledToNumber(scaled, scale)
 * if (ratio !== null) {
 *   // Safe to use ratio
 * }
 * ```
 */
export function tryScaledToNumber(scaled: bigint, scale: bigint): number | null {
  try {
    return scaledToNumber(scaled, scale)
  } catch {
    return null
  }
}

/**
 * Converts an exact fraction to a JavaScript Number using safe scaling.
 *
 * @param p - Numerator of the fraction (must be >= 0)
 * @param q - Denominator of the fraction (must be > 0)
 * @param rounding - Rounding mode for the conversion
 * @returns The fraction as a JavaScript Number
 *
 * @example
 * ```typescript
 * const exactRatio = ratio(1n, 3n)
 * const decimal = ratioToNumber(exactRatio.p, exactRatio.q)  // 0.3333...
 * ```
 */
export function ratioToNumber(p: bigint, q: bigint, rounding: Rounding = 'half-up'): number {
  const { scaled, scale } = scaleRatioForNumber(p, q, rounding)
  return scaledToNumber(scaled, scale)
}

/**
 * Converts an exact fraction to a fixed-precision decimal string.
 *
 * @param p - Numerator of the fraction (must be >= 0)
 * @param q - Denominator of the fraction (must be > 0)
 * @param decimals - Number of decimal places (default: 6)
 * @param rounding - Rounding mode for the conversion
 * @returns Fixed-precision decimal string
 *
 * @example
 * ```typescript
 * ratioToFixed(1n, 3n, 4)  // "0.3333"
 * ratioToFixed(22n, 7n, 6) // "3.142857"
 * ```
 */
export function ratioToFixed(p: bigint, q: bigint, decimals = 6, rounding: Rounding = 'half-up'): string {
  assertPositiveBigint('q', q)
  if (decimals < 0) throw new Error('decimals must be >= 0')

  const scale = 10n ** BigInt(decimals)
  const scaledResult = divRound(p * scale, q, rounding)
  const resultString = scaledResult.toString()

  if (decimals === 0) return resultString

  const integerPart = resultString.length > decimals ? resultString.slice(0, -decimals) : '0'
  const fractionalPart = resultString.padStart(decimals + 1, '0').slice(-decimals)

  return `${integerPart}.${fractionalPart}`
}

// ============================================================================
// High-Level Convenience Functions
// ============================================================================

/**
 * Safely calculates: pricePerTiB × storageAmount without overflow.
 * Use instead of direct multiplication that might exceed Number.MAX_SAFE_INTEGER.
 *
 * @param pricePerTiB - Price per TiB as bigint (must be >= 0)
 * @param storageAmount - Storage amount as JavaScript number (must be >= 0)
 * @returns Safe product as bigint
 *
 * @example
 * ```typescript
 * // Instead of: pricePerTiB * BigInt(storageAmount) - might overflow
 * const rate = calculateRate(pricePerTiB, storageAmount)
 * ```
 */
export function calculateRate(pricePerTiB: bigint, storageAmount: number): bigint {
  assertNonNegativeBigint('pricePerTiB', pricePerTiB)
  assertNonNegativeNumber('storageAmount', storageAmount)

  const { scaled, scale } = scaleNumberRatio(storageAmount, 1)
  return (pricePerTiB * scaled) / scale
}

/**
 * Safely calculates a ratio and returns it as a JavaScript Number.
 * Throws if the result would be too large for safe Number conversion.
 *
 * @param numerator - Ratio numerator as bigint (must be >= 0)
 * @param denominator - Ratio denominator as bigint (must be > 0)
 * @param rounding - Rounding mode (default: 'half-up')
 * @returns Ratio as JavaScript Number
 * @throws Error if conversion would overflow or lose precision
 *
 * @example
 * ```typescript
 * // Instead of: Number(depositedAmount) / Number(requiredDeposit) - might lose precision
 * const ratio = calculateRatioAsNumber(depositedAmount, requiredDeposit)
 * const actualGiB = potentialGiB * ratio
 * ```
 */
export function calculateRatioAsNumber(numerator: bigint, denominator: bigint, rounding: Rounding = 'half-up'): number {
  assertNonNegativeBigint('numerator', numerator)
  assertPositiveBigint('denominator', denominator)

  const { scaled, scale } = scaleRatioForNumber(numerator, denominator, rounding)
  return scaledToNumber(scaled, scale)
}

/**
 * Safely calculates a ratio as a JavaScript Number with graceful overflow handling.
 * Returns null instead of throwing if the result would be too large.
 *
 * @param numerator - Ratio numerator as bigint (must be >= 0)
 * @param denominator - Ratio denominator as bigint (must be > 0)
 * @param rounding - Rounding mode (default: 'half-up')
 * @returns Ratio as Number, or null if too large for safe conversion
 *
 * @example
 * ```typescript
 * const ratio = calculateRatioSafe(veryLargeNumerator, denominator)
 * if (ratio !== null) {
 *   const actualGiB = potentialGiB * ratio
 * } else {
 *   // Handle the large number case differently
 * }
 * ```
 */
export function calculateRatioSafe(
  numerator: bigint,
  denominator: bigint,
  rounding: Rounding = 'half-up'
): number | null {
  assertNonNegativeBigint('numerator', numerator)
  assertPositiveBigint('denominator', denominator)

  const { scaled, scale } = scaleRatioForNumber(numerator, denominator, rounding)
  return tryScaledToNumber(scaled, scale)
}

// Note: calculateEpochs removed - epoch calculations don't need overflow protection
// With 2880 epochs/day, overflow won't occur until 8.5+ billion years

/**
 * Applies a bigint ratio to a JavaScript number safely.
 * Use for proportional calculations like: baseValue × (numerator / denominator).
 *
 * @param baseValue - Base value as JavaScript number (must be >= 0)
 * @param numerator - Ratio numerator as bigint (must be >= 0)
 * @param denominator - Ratio denominator as bigint (must be > 0)
 * @param rounding - Rounding mode (default: 'half-up')
 * @returns baseValue × ratio as JavaScript Number
 *
 * @example
 * ```typescript
 * // Instead of: potentialGiB * Number(deposited) / Number(required) - might lose precision
 * const actualGiB = applyRatio(potentialGiB, depositedAmount, requiredDeposit)
 * ```
 */
export function applyRatio(
  baseValue: number,
  numerator: bigint,
  denominator: bigint,
  rounding: Rounding = 'half-up'
): number {
  assertNonNegativeNumber('baseValue', baseValue)

  const ratioValue = calculateRatioAsNumber(numerator, denominator, rounding)
  return baseValue * ratioValue
}
