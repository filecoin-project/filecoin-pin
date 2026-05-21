/**
 * Parse the `--validity-days` CLI option into a positive integer.
 *
 * Rejects non-digit characters so values like `"10foo"` fail loudly instead of
 * being silently truncated. Upper-bound enforcement lives in
 * {@link authorizeSessionAddress}.
 */
export function parseValidityDays(raw: string | undefined, fallback = 10): number {
  const value = raw ?? String(fallback)
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid --validity-days: ${raw}`)
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --validity-days: ${raw}`)
  }
  return parsed
}
