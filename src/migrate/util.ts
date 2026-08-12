/**
 * Small helpers for the migrate runner: stderr logging, size parsing, a
 * bounded concurrency pool, and CID-list parsing.
 */

/** Log to stderr so stdout stays reserved for machine-readable output. */
export function log(...args: unknown[]): void {
  console.error(...args)
}

const SIZE_UNITS: Record<string, bigint> = {
  b: 1n,
  k: 1024n,
  kib: 1024n,
  m: 1024n ** 2n,
  mib: 1024n ** 2n,
  g: 1024n ** 3n,
  gib: 1024n ** 3n,
  t: 1024n ** 4n,
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

/**
 * Run `fn` over `items` with at most `limit` in flight at once. Preserves input
 * order in the returned array. Rejections are captured per-item so one failure
 * does not abort the whole batch.
 */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<Array<{ ok: true; value: R } | { ok: false; error: Error }>> {
  const results = new Array<{ ok: true; value: R } | { ok: false; error: Error }>(items.length)
  let cursor = 0

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++
      // `index < items.length` guarantees the element exists; the cast covers
      // noUncheckedIndexedAccess.
      const item = items[index] as T
      try {
        results[index] = { ok: true, value: await fn(item, index) }
      } catch (err) {
        results[index] = { ok: false, error: err instanceof Error ? err : new Error(String(err)) }
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
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
