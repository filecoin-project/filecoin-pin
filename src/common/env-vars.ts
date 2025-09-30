/**
 * Generic helpers for environment variable parsing and validation.
 */

export const envToBool = (value: string | undefined, defaultValue: boolean): boolean => {
  if (value === undefined) return defaultValue
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return defaultValue
}
