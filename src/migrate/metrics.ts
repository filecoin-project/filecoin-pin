/**
 * Formatting and timing helpers for the migrate pipeline's logs and summary.
 */

const KIB = 1024
const MIB = 1024 * 1024
const GIB = 1024 * 1024 * 1024

/** Human-readable byte count: B, KiB, MiB, or GiB with two significant decimals. */
export function formatBytes(bytes: number): string {
  if (bytes >= GIB) {
    return `${(bytes / GIB).toFixed(2)} GiB`
  }
  if (bytes >= MIB) {
    return `${(bytes / MIB).toFixed(2)} MiB`
  }
  if (bytes >= KIB) {
    return `${(bytes / KIB).toFixed(2)} KiB`
  }
  return `${bytes} B`
}

/** Human-readable duration from milliseconds: ms under a second, else seconds. */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`
  }
  return `${(ms / 1000).toFixed(1)}s`
}

/** A single timed span. `stop()` returns elapsed milliseconds. */
export class Timer {
  #start: number

  constructor() {
    this.#start = performance.now()
  }

  stop(): number {
    return performance.now() - this.#start
  }
}
