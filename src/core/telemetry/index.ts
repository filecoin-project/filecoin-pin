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
 * Events are aggregated in memory by (metric name, tag set) and flushed to the
 * endpoint every 60 seconds, plus a final flush when the host's lifecycle is
 * ending: `beforeExit` in Node and `pagehide` in the browser. Long-running
 * consumers that terminate via `process.exit()` or signals should call
 * {@link shutdownTelemetry} explicitly.
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

interface BufferedPoint {
  name: string
  tags: Record<string, string>
  value: number
}

const FLUSH_INTERVAL_MS = 60_000

let started = false
let disabled = false
let endpoint = DEFAULT_METRICS_ENDPOINT
let token = DEFAULT_METRICS_TOKEN
let runtimeOverrides: RuntimeOverrides = {}

const buffer = new Map<string, BufferedPoint>()
let flushTimer: ReturnType<typeof setInterval> | null = null
let beforeExitListener: (() => void) | null = null
let pageHideListener: (() => void) | null = null

function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && typeof process.once === 'function'
}

/**
 * Configure telemetry at runtime. Must be called before the first
 * `executeUpload`; calling it after telemetry has initialized has no effect
 * on the active session. CLI hosts that want env-var support should read
 * their environment themselves and forward the values here.
 */
export function configureTelemetry(overrides: RuntimeOverrides): void {
  runtimeOverrides = { ...runtimeOverrides, ...overrides }
}

function registerExitHandler(): void {
  const flush = () => {
    void shutdownTelemetry()
  }
  if (isNodeRuntime()) {
    beforeExitListener = flush
    process.once('beforeExit', beforeExitListener)
    return
  }
  if (typeof addEventListener === 'function') {
    // `pagehide` is the closest browser equivalent to Node's `beforeExit` —
    // it fires for tab close, navigation, and bfcache eviction.
    pageHideListener = flush
    addEventListener('pagehide', pageHideListener, { once: true })
  }
}

function unregisterExitHandler(): void {
  if (beforeExitListener != null && isNodeRuntime()) {
    process.removeListener('beforeExit', beforeExitListener)
    beforeExitListener = null
  }
  if (pageHideListener != null && typeof removeEventListener === 'function') {
    removeEventListener('pagehide', pageHideListener)
    pageHideListener = null
  }
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

  flushTimer = setInterval(() => {
    void flushTelemetry()
  }, FLUSH_INTERVAL_MS)
  // Don't keep the Node event loop alive solely on the flush timer.
  if (isNodeRuntime() && typeof flushTimer.unref === 'function') {
    flushTimer.unref()
  }
  registerExitHandler()
  return true
}

function bufferKey(name: string, tags: Record<string, string>): string {
  const entries = Object.keys(tags)
    .sort()
    .map((k) => [k, tags[k]])
  return JSON.stringify([name, entries])
}

function increment(name: string, tags: Record<string, string>): void {
  const key = bufferKey(name, tags)
  const existing = buffer.get(key)
  if (existing != null) {
    existing.value += 1
    return
  }
  buffer.set(key, { name, tags, value: 1 })
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

/**
 * Record one upload's per-copy outcomes. Safe to call when telemetry is
 * disabled (no-op).
 *
 * @param result - The structured upload result returned by Synapse.
 * @param network - URL-safe network slug (e.g. `mainnet`, `calibration`).
 */
export function recordUploadResult(result: Pick<UploadResult, 'copies' | 'failedAttempts'>, network: string): void {
  if (!start()) return

  for (const copy of result.copies) {
    increment(METRIC_UPLOAD_COPIES_SUCCESS, {
      'upload.spId': String(copy.providerId),
      'upload.role': copy.role,
      network,
    })
  }
  for (const attempt of result.failedAttempts) {
    increment(METRIC_UPLOAD_COPIES_FAILURE, {
      'upload.spId': String(attempt.providerId),
      'upload.role': attempt.role,
      'upload.step': classifyStep(attempt.error),
      network,
    })
  }
}

/**
 * Flush pending metrics to the endpoint. Call at process exit or when the
 * caller wants to guarantee delivery before continuing. Safe when disabled.
 */
export async function flushTelemetry(): Promise<void> {
  if (!started || disabled || buffer.size === 0) return

  const points = Array.from(buffer.values())
  buffer.clear()

  const dt = new Date().toISOString()
  const body = points.map((p) => ({
    name: p.name,
    counter: { value: p.value },
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
 * Shut down telemetry. Cancels the periodic flush, flushes any buffered
 * points, and turns subsequent record calls into no-ops. Intended for tests
 * and long-lived hosts that need clean teardown.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!started || disabled) return
  unregisterExitHandler()
  if (flushTimer != null) {
    clearInterval(flushTimer)
    flushTimer = null
  }
  await flushTelemetry()
  disabled = true
}

/**
 * Test hook: reset the singleton so a subsequent call re-reads configuration.
 * Not part of the public API.
 *
 * @internal
 */
export function _resetTelemetryForTests(): void {
  unregisterExitHandler()
  if (flushTimer != null) {
    clearInterval(flushTimer)
    flushTimer = null
  }
  started = false
  disabled = false
  runtimeOverrides = {}
  buffer.clear()
}
