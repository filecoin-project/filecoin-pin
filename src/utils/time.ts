/**
 * Helpers for formatting time-like values for CLI display.
 */

const DAYS_PER_MONTH = 30
const DAYS_PER_YEAR = 365

/**
 * Format a runway duration for human-readable CLI output.
 *
 * - For small values (< 60 days): include days and hours
 * - For medium values (< 365 days): include months and days (30-day months)
 * - For large values (>= 365 days): include years, months and days (365-day years, 30-day months)
 *
 * @param days - Whole days of runway (non-negative)
 * @param hoursRemainder - Hours remainder (0-23). Ignored when days >= 60
 * @returns A formatted string, e.g., "5 day(s) 12 hour(s)" or "1 year(s) 2 month(s) 3 day(s)"
 */
export function formatRunwayDuration(days: number, hoursRemainder: number = 0): string {
  const d = Math.max(0, Math.floor(days))
  const h = Math.max(0, Math.floor(hoursRemainder))

  // Small durations: show days + hours
  if (d < 60) {
    const hoursPart = h > 0 ? ` ${h} hour(s)` : ''
    return `${d} day(s)${hoursPart}`
  }

  // Medium durations: months + days
  if (d < DAYS_PER_YEAR) {
    const months = Math.floor(d / DAYS_PER_MONTH)
    const daysRem = d % DAYS_PER_MONTH
    const parts = [months > 0 ? `${months} month(s)` : '', daysRem > 0 ? `${daysRem} day(s)` : ''].filter(Boolean)
    return parts.join(' ')
  }

  // Large durations: years + months + days
  const years = Math.floor(d / DAYS_PER_YEAR)
  const afterYears = d % DAYS_PER_YEAR
  const months = Math.floor(afterYears / DAYS_PER_MONTH)
  const daysRem = afterYears % DAYS_PER_MONTH
  const parts = [
    years > 0 ? `${years} year(s)` : '',
    months > 0 ? `${months} month(s)` : '',
    daysRem > 0 ? `${daysRem} day(s)` : '',
  ].filter(Boolean)
  return parts.join(' ')
}
