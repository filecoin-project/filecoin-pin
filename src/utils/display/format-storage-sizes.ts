import { type StorageUnit, storageUnitToNumber } from '../capacity/units.js'

/**
 * Format storage capacity with smart unit selection.
 *
 * @param su - Capacity as a `StorageUnit` (value + unit, optional remainder)
 * @param precision - Number of decimal places
 * @returns Formatted string with appropriate unit (e.g. "1.5 TiB/month")
 */
export function formatStorageCapacity(su: StorageUnit, precision: number = 1): string {
  if (su.value <= 0n && (su.remainder?.bytes ?? 0n) <= 0n) {
    return '0 B/month'
  }

  return `${formatStorageSize(su, precision)}/month`
}

/**
 * Format a `StorageUnit` to a human-readable size.
 *
 * @param su - Storage amount as a `StorageUnit`
 * @param precision - Number of decimal places
 * @returns Human-readable string like "1.5 TiB", "500 GiB", "2 MiB"
 */
export function formatStorageSize(su: StorageUnit, precision: number = 2): string {
  if (su.value <= 0n && (su.remainder?.bytes ?? 0n) <= 0n) {
    return '0 B'
  }
  const storageUnitNumber = storageUnitToNumber(su)

  return `${storageUnitNumber.value.toLocaleString(undefined, { minimumFractionDigits: precision, maximumFractionDigits: precision })} ${storageUnitNumber.unit}`
}
