/**
 * Throughput and timing helpers for the migrate stages.
 *
 * The work is I/O-bound (gateway downloads during the commP pass, provider
 * stores during upload, on-chain confirmation), so the numbers that matter are
 * wall-clock duration and effective byte rate per stage. These helpers format
 * those consistently for the CLI logs and the run summary, and carry no state
 * beyond what a caller passes in.
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

/** Byte rate as MiB/s over an elapsed window; reports `n/a` for a zero window. */
export function formatRate(bytes: number, ms: number): string {
  if (ms <= 0) {
    return 'n/a'
  }
  const mibPerSec = bytes / MIB / (ms / 1000)
  return `${mibPerSec.toFixed(2)} MiB/s`
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

/**
 * Accumulator for a stage that processes many items, each carrying a byte size.
 * Tracks item count, total bytes, and per-item durations so the stage can report
 * aggregate throughput (total bytes over wall time) alongside per-item latency.
 */
export class StageStats {
  #wall = new Timer()
  #items = 0
  #bytes = 0
  #durationsMs: number[] = []

  record(bytes: number, durationMs: number): void {
    this.#items += 1
    this.#bytes += bytes
    this.#durationsMs.push(durationMs)
  }

  summary(): StageSummary {
    const wallMs = this.#wall.stop()
    const sorted = [...this.#durationsMs].sort((a, b) => a - b)
    const p50 = percentile(sorted, 0.5)
    const p95 = percentile(sorted, 0.95)
    return {
      items: this.#items,
      bytes: this.#bytes,
      wallMs,
      rate: formatRate(this.#bytes, wallMs),
      p50Ms: p50,
      p95Ms: p95,
    }
  }
}

export interface StageSummary {
  items: number
  bytes: number
  wallMs: number
  rate: string
  p50Ms: number
  p95Ms: number
}

/** Format a stage summary as one log line. */
export function formatStageSummary(label: string, s: StageSummary): string {
  return (
    `${label}: ${s.items} item(s), ${formatBytes(s.bytes)} in ${formatDuration(s.wallMs)} ` +
    `(${s.rate}; per-item p50 ${formatDuration(s.p50Ms)}, p95 ${formatDuration(s.p95Ms)})`
  )
}

function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) {
    return 0
  }
  const idx = Math.min(sortedAsc.length - 1, Math.floor(q * sortedAsc.length))
  return sortedAsc[idx] ?? 0
}
