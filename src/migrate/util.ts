/**
 * Small helpers for the migrate runner: size parsing and CID-list parsing.
 * Output goes through `src/utils/cli-logger.ts` like every other command.
 */

// Decimal spellings (kb, mb, ...) are accepted as binary aliases: staging
// sizes are power-of-two territory and rejecting `32GB` helps nobody.
const SIZE_UNITS: Record<string, bigint> = {
  b: 1n,
  k: 1024n,
  kb: 1024n,
  kib: 1024n,
  m: 1024n ** 2n,
  mb: 1024n ** 2n,
  mib: 1024n ** 2n,
  g: 1024n ** 3n,
  gb: 1024n ** 3n,
  gib: 1024n ** 3n,
  t: 1024n ** 4n,
  tb: 1024n ** 4n,
  tib: 1024n ** 4n,
}

/**
 * Parse a size like "32GiB", "1MiB", or a raw byte count "34359738368".
 */
export function parseSize(input: string): bigint {
  const trimmed = input.trim().toLowerCase()
  const match = trimmed.match(/^(\d+)\s*([a-z]*)$/)
  if (match?.[1] == null) {
    throw new Error(`invalid size: ${input}`)
  }
  const value = BigInt(match[1])
  const unit = match[2] == null || match[2] === '' ? 'b' : match[2]
  const multiplier = SIZE_UNITS[unit]
  if (multiplier == null) {
    throw new Error(`unknown size unit "${unit}" in ${input}`)
  }
  return value * multiplier
}

/** Parse a positive integer flag value; throws a clear error for missing or non-positive input. */
export function parsePositiveInt(raw: string | undefined, flag: string): number {
  if (raw == null) {
    throw new Error(`${flag} requires a value`)
  }
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || String(n) !== raw.trim()) {
    throw new Error(`${flag} must be a positive integer (got ${JSON.stringify(raw)})`)
  }
  return n
}

/** Read a CID list file: one CID per line, blank lines and `#` comments ignored. */
export function parseCidList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}
