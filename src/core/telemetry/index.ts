/**
 * Anonymous upload telemetry.
 *
 * Emits two counters via direct HTTP POST to BetterStack
 * (https://betterstack.com/docs/logs/ingesting-data/http/metrics/) so we can
 * gauge the multi-copy success rate of `executeUpload`:
 *
 * - `upload.copies.success` — per successful copy, attributed by `upload.spId`
 *   and `upload.role` (primary/secondary).
 * - `upload.copies.failure` — per failed copy attempt, attributed by
 *   `upload.spId`, `upload.role`, and `upload.step` (which sub-step of the
 *   upload pipeline tripped the failure).
 *
 * Works in both Node and the browser. The library never reads its own
 * environment — callers are expected to apply any host-specific configuration
 * (env vars, CLI flags, browser globals) by invoking {@link configureTelemetry}
 * before the first `executeUpload`.
 *
 * Each call to {@link recordUploadResult} fires its own HTTP POST — there is
 * no in-memory buffer or periodic flush. Use {@link flushTelemetry} to await
 * pending requests, or {@link shutdownTelemetry} to do that and turn
 * subsequent record calls into no-ops.
 */

import type { UploadResult } from '@filoz/synapse-sdk'
import {
  DEFAULT_METRICS_ENDPOINT,
  DEFAULT_METRICS_TOKEN,
  METRIC_UPLOAD_COPIES_FAILURE,
  METRIC_UPLOAD_COPIES_SUCCESS,
  TELEMETRY_SERVICE_NAME,
} from './constants.js'

interface RuntimeOverrides {
  disabled?: boolean
  endpoint?: string
  token?: string
}

interface MetricPoint {
  name: string
  tags: Record<string, string>
}

let started = false
let disabled = false
let endpoint = DEFAULT_METRICS_ENDPOINT
let token = DEFAULT_METRICS_TOKEN
let runtimeOverrides: RuntimeOverrides = {}
const inFlight = new Set<Promise<void>>()

/**
 * Configure telemetry at runtime. Must be called before the first
 * `executeUpload`; calling it after telemetry has initialized has no effect
 * on the active session. CLI hosts that want env-var support should read
 * their environment themselves and forward the values here.
 */
export function configureTelemetry(overrides: RuntimeOverrides): void {
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
  started = true
  return true
}

/**
 * Map a SDK failure `error` string to a coarse step name.
 * Keep this short list of buckets — high-cardinality strings would defeat
 * the purpose of the counter.
 */
function classifyStep(error: string): string {
  const lower = error.toLowerCase()
  if (lower.startsWith('pull failed')) return 'pull'
  if (lower.startsWith('commit failed')) return 'commit'
  return 'unknown'
}

async function post(points: MetricPoint[]): Promise<void> {
  const dt = new Date().toISOString()
  const body = points.map((p) => ({
    name: p.name,
    counter: { value: 1 },
    dt,
    tags: { 'service.name': TELEMETRY_SERVICE_NAME, ...p.tags },
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
      name: METRIC_UPLOAD_COPIES_SUCCESS,
      tags: {
        'upload.spId': String(copy.providerId),
        'upload.role': copy.role,
        network,
      },
    })
  }
  for (const attempt of result.failedAttempts) {
    points.push({
      name: METRIC_UPLOAD_COPIES_FAILURE,
      tags: {
        'upload.spId': String(attempt.providerId),
        'upload.role': attempt.role,
        'upload.step': classifyStep(attempt.error),
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
