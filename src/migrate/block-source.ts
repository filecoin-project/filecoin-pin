/**
 * Transient-failure classification for block retrieval.
 *
 * A trustless gateway's load balancer hands each fresh connection to a
 * backend with its own cache, and a backend that misses returns 504 until its
 * upstream fetch lands, so a cold DAG needs bounded per-block retries, not a
 * failed walk. Only failure signatures known to be transient retry; a 404, a
 * hash mismatch, or an abort stays terminal and loud.
 */

/** Every error message in a (possibly nested) AggregateError chain. */
export function messagesOf(err: unknown): string[] {
  if (err instanceof AggregateError) return err.errors.flatMap(messagesOf)
  return [err instanceof Error ? err.message : String(err)]
}

/**
 * True for failure signatures known to be transient at the gateway: a cold
 * backend answers 429/5xx until its upstream fetch caches the block, and a
 * dropped connection surfaces as a fetch failure.
 */
export function isTransientBlockError(err: unknown): boolean {
  return messagesOf(err).some((m) => /received (429|5\d\d) |Failed to fetch|fetch failed/i.test(m))
}

export const BLOCK_RETRY_DELAYS_MS = [1_000, 2_000, 4_000]
