/**
 * Truncates a string to a maximum length while preserving its suffix when
 * possible.
 *
 * For lengths greater than 7, the string is truncated in the middle,
 * preserving the last 6 characters and inserting an ellipsis (`…`).
 * For shorter limits, the string is truncated at the end and suffixed with
 * an ellipsis.
 *
 * The returned string will never exceed `max` characters.
 */
export function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  if (max <= 0) return ''

  if (max <= 7) {
    return `${str.slice(0, max - 1)}…`
  }

  return `${str.slice(0, max - 7)}…${str.slice(-6)}`
}
