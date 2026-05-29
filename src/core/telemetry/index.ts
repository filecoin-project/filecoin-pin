/**
 * Anonymous upload telemetry — one `uploadCopyStatus` counter per resolved
 * copy attempt. See
 * [`documentation/events-and-metrics.md`](../../../documentation/events-and-metrics.md)
 * for the schema, delivery model, and tag values.
 *
 * Library never reads its own environment; callers must apply host-specific
 * configuration via {@link configureTelemetry} before the first
 * {@link recordUploadResult}.
 */

import type { UploadResult } from '@filoz/synapse-sdk'
import { METRIC_UPLOAD_COPY_BYTES, METRIC_UPLOAD_COPY_STATUS, METRICS_ENDPOINT, METRICS_TOKEN } from './constants.js'

/**
 * Which surface the metric was emitted from. Every metric carries this as a
 * tag so we can slice success/failure rates per UI. Defaults to `'Library'`
 * when {@link configureTelemetry} is not called with an explicit value.
 */
export const AFFORDANCES = ['CLI', 'GitHub Action', 'Library', 'pin.filecoin.cloud'] as const
export type Affordance = (typeof AFFORDANCES)[number]

const DEFAULT_AFFORDANCE: Affordance = 'Library'

/**
 * Full telemetry configuration. The module holds one of these as its current
 * config; {@link configureTelemetry} accepts a `Partial<TelemetryConfiguration>`
 * so callers can override just the fields they care about.
 */
export interface TelemetryConfiguration {
  disabled: boolean
  affordance: Affordance
}

interface MetricPoint {
  name: string
  /** Which BetterStack metric body shape to use for this point. */
  type: 'counter' | 'gauge'
  /** Counter increments are always 1; gauge values are the raw reading. */
  value: number
  tags: Record<string, string>
}

/**
 * Upper bound on any single submission. Without this, a stuck BetterStack
 * endpoint would also stick every `await flushTelemetry()` we do before
 * `process.exit()`, turning a telemetry hiccup into a hung CLI / Action /
 * server shutdown.
 */
const POST_TIMEOUT_MS = 10_000

let config: TelemetryConfiguration = {
  disabled: false,
  affordance: DEFAULT_AFFORDANCE,
}
const inFlight = new Set<Promise<void>>()

/**
 * Configure telemetry at runtime. CLI hosts that want env-var support should
 * read their environment themselves and forward the values here. Only the
 * fields present in `overrides` are updated; the rest retain their current
 * value.
 *
 * Throws if `overrides.affordance` is set to a value outside {@link AFFORDANCES}
 * (callers may not be in TypeScript, so we validate at runtime too).
 */
export function configureTelemetry(overrides: Partial<TelemetryConfiguration>): void {
  if (overrides.affordance != null && !(AFFORDANCES as readonly string[]).includes(overrides.affordance)) {
    throw new TypeError(
      `Invalid telemetry affordance ${JSON.stringify(overrides.affordance)}; expected one of ${AFFORDANCES.join(', ')}`
    )
  }
  config = { ...config, ...overrides }
}

/**
 * Map a SDK failure `error` string to a coarse outcome value. Keep this
 * short list of buckets — high-cardinality strings would defeat the purpose
 * of the counter.
 */
function classifyFailure(error: string): string {
  const lower = error.toLowerCase()
  if (lower.startsWith('pull failed')) return 'failure.pull'
  if (lower.startsWith('commit failed')) return 'failure.commit'
  return 'failure.other'
}

async function post(points: MetricPoint[]): Promise<void> {
  const dt = new Date().toISOString()
  const body = points.map((p) => ({
    name: p.name,
    [p.type]: { value: p.value },
    dt,
    tags: { affordance: config.affordance, ...p.tags },
  }))
  try {
    await fetch(METRICS_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${METRICS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    })
  } catch {
    // Best-effort: telemetry must never break the host (also catches timeout aborts).
  }
}

/**
 * Record one upload's per-copy outcomes — for each entry in `result.copies`
 * and `result.failedAttempts` we emit a paired `uploadCopyStatus` counter and
 * `uploadCopyBytes` gauge sharing the same tag set. No-op when disabled.
 *
 * @param result - The structured upload result returned by Synapse.
 * @param network - URL-safe network slug (e.g. `mainnet`, `calibration`).
 */
export function recordUploadResult(
  result: Pick<UploadResult, 'copies' | 'failedAttempts' | 'size'>,
  network: string
): void {
  if (config.disabled) return

  const points: MetricPoint[] = []
  const pushPair = (tags: Record<string, string>) => {
    points.push({ name: METRIC_UPLOAD_COPY_STATUS, type: 'counter', value: 1, tags })
    points.push({ name: METRIC_UPLOAD_COPY_BYTES, type: 'gauge', value: result.size, tags })
  }
  for (const copy of result.copies) {
    pushPair({
      spId: String(copy.providerId),
      role: copy.role,
      status: 'success',
      network,
    })
  }
  for (const attempt of result.failedAttempts) {
    pushPair({
      spId: String(attempt.providerId),
      role: attempt.role,
      status: classifyFailure(attempt.error),
      network,
    })
  }
  if (points.length === 0) return

  const promise = post(points).finally(() => {
    inFlight.delete(promise)
  })
  inFlight.add(promise)
}

/**
 * Await any in-flight HTTP submissions. Call before exit (or in tests) to
 * guarantee delivery. Safe when nothing is pending, does not await any new
 * requests started during its lifecycle.
 */
export async function flushTelemetry(): Promise<void> {
  if (inFlight.size === 0) return
  await Promise.all(inFlight)
}
