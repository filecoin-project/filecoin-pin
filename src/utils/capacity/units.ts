import { SIZE_CONSTANTS as SIZE_CONSTANTS_base } from '@filoz/synapse-sdk'
import { scaledToNumber, scaleRatio } from '../numbers/safe-scaling.js'

const SIZE_CONSTANTS_CUSTOM = {
  B: 1n as const,
  KiB: SIZE_CONSTANTS_base.KiB,
  MiB: SIZE_CONSTANTS_base.MiB,
  GiB: SIZE_CONSTANTS_base.GiB,
  TiB: SIZE_CONSTANTS_base.TiB,
  PiB: 1n << 50n,
}

export type BinaryUnit = keyof typeof SIZE_CONSTANTS_CUSTOM

// separate from custom constants to avoid circular dependency
export const SIZE_CONSTANTS: Record<BinaryUnit, bigint> = SIZE_CONSTANTS_CUSTOM

export const SIZE_CONSTANTS_NUMBER: Record<BinaryUnit, number> = {
  PiB: Number(SIZE_CONSTANTS.PiB),
  TiB: Number(SIZE_CONSTANTS.TiB),
  GiB: Number(SIZE_CONSTANTS.GiB),
  MiB: Number(SIZE_CONSTANTS.MiB),
  KiB: Number(SIZE_CONSTANTS.KiB),
  B: 1,
}

// Build a descending list of units by factor (YiB..B if present)
const UNITS_DESC: BinaryUnit[] = (Object.entries(SIZE_CONSTANTS) as [BinaryUnit, bigint][])
  .sort(([, a], [, b]) => (a === b ? 0 : a < b ? 1 : -1))
  .map(([u]) => u)

/**
 * Interface for the remainder of a storage unit, used when converting a smaller unit to a larger unit.
 */
export interface StorageRemainder {
  bytes: bigint
  denom: BinaryUnit
}

/**
 * Simplified units for storage capacity.. exports a normalized interface for value and unit, which should be used to represent storage capacity.
 */
export interface StorageUnit {
  /**
   * The whole number of the StorageUnit at the BinaryUnit
   */
  value: bigint

  /**
   * The remainder of the StorageUnit at the BinaryUnit, only present if a conversion is not whole (i.e. if you convert up, you get a remainder).
   */
  remainder?: StorageRemainder | undefined

  /**
   * The unit of the StorageUnit, i.e. B, KiB, MiB, GiB, TiB, PiB
   */
  unit: BinaryUnit
}

/**
 * A number representation of a storage unit, to be used in UI.
 *
 * @example
 * ```ts
 * const s = { value: 1.5, unit: 'GiB' }
 * const n = storageUnitToNumber(s)
 * console.log(`${n.value} ${n.unit}`) // "1.5 GiB"
 * ```
 */
export type StorageUnitNumber = {
  value: number
  unit: BinaryUnit
}

/**
 * Normalize raw bytes to the largest unit whose factor <= bytes.
 * If bytes < 1 KiB, unit is 'B'.
 * If bytes < 1 MiB, unit is 'KiB'.
 * If bytes < 1 GiB, unit is 'MiB'.
 * If bytes < 1 TiB, unit is 'GiB'.
 * If bytes < 1 PiB, unit is 'TiB'.
 * If bytes >= 1 PiB, unit is 'PiB'.
 */
export function getStorageUnitBI(bytes: bigint): StorageUnit {
  if (bytes <= 0n) return { value: 0n, unit: 'B' }
  for (const u of UNITS_DESC) {
    const f = SIZE_CONSTANTS[u]
    if (bytes >= f) return { value: bytes / f, unit: u }
  }
  return { value: bytes, unit: 'B' }
}

/**
 * This function will return the correctly formatted storage unit from a number.
 *
 * @param size - The size of the storage unit, as a number, if you want to pass a large bigint value, use getStorageUnitBI instead
 * @returns the correctly formatted storage unit
 */
export function getStorageUnit(size: number): StorageUnit {
  if (size <= 0) return { value: 0n, unit: 'B' }
  const bytes = BigInt(Math.floor(size))
  const storageUnit = getStorageUnitBI(bytes)
  const factor = SIZE_CONSTANTS[storageUnit.unit]
  // Special handling for smallest unit: we can't represent sub-byte remainders.
  // Use round-half-down so 1.5 B -> 1 B, 1.9 B -> 2 B, 1.1 B -> 1 B.
  if (storageUnit.unit === 'B') {
    const roundedBytes = Math.ceil(size - 0.5)
    return { value: BigInt(roundedBytes), unit: 'B' }
  }
  const remainderBytes = bytes % factor
  if (remainderBytes > 0n) {
    return { ...storageUnit, remainder: { bytes: remainderBytes, denom: storageUnit.unit } }
  }
  return storageUnit
}

/**
 * Instead of passing a large bigint value, you can pass a number and a unit and this function will return the correct StorageUnit.
 *
 * @param size - The size of the storage unit, as a number
 * @param unit - The unit of the storage unit, as a keyof typeof SIZE_CONSTANTS
 * @returns the correctly formatted storage unit
 */
export function makeStorageUnit(size: number, unit: BinaryUnit): StorageUnit {
  if (size <= 0) return { value: 0n, unit }
  // Special handling for smallest unit: we can't represent sub-byte remainders.
  // Use round-half-down so 1.5 B -> 1 B, 1.9 B -> 2 B, 1.1 B -> 1 B.
  if (unit === 'B') {
    const roundedBytes = Math.ceil(size - 0.5)
    return { value: BigInt(roundedBytes), unit: 'B' }
  }

  const whole = Math.floor(size)
  const value = BigInt(whole)
  const fractional = size - whole
  const factorNum = SIZE_CONSTANTS_NUMBER[unit]
  const remainderBytes = BigInt(Math.round(fractional * factorNum))
  if (remainderBytes > 0n) {
    return { value, unit, remainder: { bytes: remainderBytes, denom: unit } }
  }
  return { value, unit }
}

export function toBytes(s: StorageUnit): bigint {
  // clamp negatives
  if (s.value < 0n) return 0n
  const base = s.value * SIZE_CONSTANTS[s.unit]
  const remainderBytes = s.remainder?.bytes ?? 0n
  return base + remainderBytes
}

export function convert(s: StorageUnit, target: BinaryUnit): StorageUnit {
  const bytes = toBytes(s)
  const f = SIZE_CONSTANTS[target]
  const whole = bytes / f
  const remainderBytes = bytes % f
  if (remainderBytes === 0n) {
    return { value: whole, unit: target }
  }

  return { value: whole, remainder: { bytes: remainderBytes, denom: target }, unit: target }
}

/**
 * Function to handle storage units that are not whole numbers, i.e. if you convert from bytes to KiB, you get a remainder.
 * This function will return a number for the given StorageUnit, with the remainder as a decimal.
 */
export function storageUnitToNumber(s: StorageUnit): StorageUnitNumber {
  // whole part must be safe to represent as JS number
  if (s.value > BigInt(Number.MAX_SAFE_INTEGER)) {
    // first see if we can use a higher BinaryUnit to represent the value
    const nextUnitIndex = UNITS_DESC.indexOf(s.unit) - 1
    const nextUnit = UNITS_DESC[nextUnitIndex]
    if (nextUnitIndex < 0 || !nextUnit) {
      // This should only happen if things are going really wrong, as someone would need to store > 9_007_199_254_740_991 PiB (> 8 million YiB)
      throw new Error('StorageUnit value is too large to convert to a number safely')
    }
    return storageUnitToNumber(convert(s, nextUnit))
  }

  const whole = Number(s.value)
  const unit = s.unit
  if (!s.remainder) {
    return { value: whole, unit }
  }

  // Fraction = remainder.bytes / factor(s.remainder.denom), done with bigint math.
  const den = SIZE_CONSTANTS[s.remainder.denom]
  const { scaled, scale } = scaleRatio(s.remainder.bytes, den)
  const frac = scaledToNumber(scaled, scale) // strictly < 1

  return { value: whole + frac, unit }
}
