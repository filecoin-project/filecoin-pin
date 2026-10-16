/**
 * Formatting and timing helpers for the migrate pipeline's logs and summary.
 */

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
