/**
 * Anonymous upload telemetry.
 *
 * Emits one counter — `uploadCopyStatus` — per resolved copy attempt, with a
 * `value` tag of `success | failure.pull | failure.commit | failure.other`.
 * See `documentation/events-and-metrics.md` for the full schema (events, tags,
 * and how the metric relates to the SDK's per-upload result).
 *
 * Metrics ship via direct HTTP POST to BetterStack
 * (https://betterstack.com/docs/logs/ingesting-data/http/metrics/). Each call
 * to {@link recordUploadResult} fires its own HTTP POST — there is no
 * in-memory buffer or periodic flush. Use {@link flushTelemetry} to await
 * pending requests, or {@link shutdownTelemetry} to do that and turn
 * subsequent record calls into no-ops.
 *
 * Works in both Node and the browser. The library never reads its own
 * environment — callers are expected to apply any host-specific configuration
 * (env vars, CLI flags, browser globals) by invoking {@link configureTelemetry}
 * before the first `executeUpload`.
 */

import type { UploadResult } from '@filoz/synapse-sdk'
import { DEFAULT_METRICS_ENDPOINT, DEFAULT_METRICS_TOKEN, METRIC_UPLOAD_COPY_STATUS } from './constants.js'

/**
 * Which surface the metric was emitted from. Every metric carries this as a
 * tag so we can slice success/failure rates per UI. Defaults to `'Library'`
 * when {@link configureTelemetry} is not called with an explicit value.
 */
export const AFFORDANCES = ['CLI', 'GitHub Action', 'Library', 'Filecoin Pin Website'] as const
export type Affordance = (typeof AFFORDANCES)[number]

const DEFAULT_AFFORDANCE: Affordance = 'Library'

interface RuntimeOverrides {
  disabled?: boolean
  endpoint?: string
  token?: string
  affordance?: Affordance
}

interface MetricPoint {
  name: string
  tags: Record<string, string>
}

let started = false
let disabled = false
let endpoint = DEFAULT_METRICS_ENDPOINT
let token = DEFAULT_METRICS_TOKEN
let affordance: Affordance = DEFAULT_AFFORDANCE
let runtimeOverrides: RuntimeOverrides = {}
const inFlight = new Set<Promise<void>>()

/**
 * Configure telemetry at runtime. Must be called before the first
 * `executeUpload`; calling it after telemetry has initialized has no effect
 * on the active session. CLI hosts that want env-var support should read
 * their environment themselves and forward the values here.
 *
 * Throws if `overrides.affordance` is set to a value outside {@link AFFORDANCES}
 * (callers may not be in TypeScript, so we validate at runtime too).
 */
export function configureTelemetry(overrides: RuntimeOverrides): void {
  if (overrides.affordance != null && !(AFFORDANCES as readonly string[]).includes(overrides.affordance)) {
    throw new TypeError(
      `Invalid telemetry affordance ${JSON.stringify(overrides.affordance)}; expected one of ${AFFORDANCES.join(', ')}`
    )
  }
  runtimeOverrides = { ...runtimeOverrides, ...overrides }
}

function start(): boolean {
  if (started) return !disabled
  if (runtimeOverrides.disabled === true) {
    started = true
    disabled = true
    return false
  }
  endpoint = runtimeOverrides.endpoint ?? DEFAULT_METRICS_ENDPOINT
  token = runtimeOverrides.token ?? DEFAULT_METRICS_TOKEN
  affordance = runtimeOverrides.affordance ?? DEFAULT_AFFORDANCE
  started = true
  return true
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
    counter: { value: 1 },
    dt,
    tags: { affordance, ...p.tags },
  }))
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch {
    // Best-effort: telemetry must never break the host.
  }
}

/**
 * Record one upload's per-copy outcomes. Fires a single HTTP POST containing
 * one counter point per copy and per failed attempt. Safe to call when
 * telemetry is disabled (no-op).
 *
 * @param result - The structured upload result returned by Synapse.
 * @param network - URL-safe network slug (e.g. `mainnet`, `calibration`).
 */
export function recordUploadResult(result: Pick<UploadResult, 'copies' | 'failedAttempts'>, network: string): void {
  if (!start()) return

  const points: MetricPoint[] = []
  for (const copy of result.copies) {
    points.push({
      name: METRIC_UPLOAD_COPY_STATUS,
      tags: {
        spId: String(copy.providerId),
        role: copy.role,
        value: 'success',
        network,
      },
    })
  }
  for (const attempt of result.failedAttempts) {
    points.push({
      name: METRIC_UPLOAD_COPY_STATUS,
      tags: {
        spId: String(attempt.providerId),
        role: attempt.role,
        value: classifyFailure(attempt.error),
        network,
      },
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
 * guarantee delivery. Safe when nothing is pending.
 */
export async function flushTelemetry(): Promise<void> {
  if (inFlight.size === 0) return
  await Promise.all(inFlight)
}

/**
 * Await pending submissions and turn subsequent record calls into no-ops.
 * Intended for tests and long-lived hosts that need clean teardown.
 */
export async function shutdownTelemetry(): Promise<void> {
  await flushTelemetry()
  disabled = true
  started = true
}
