/**
 * Anonymous upload telemetry.
 *
 * Emits two counters via OpenTelemetry/OTLP-HTTP so we can gauge the
 * multi-copy success rate of `executeUpload`:
 *
 * - `upload.copies.success` — per successful copy, attributed by `upload.spId`
 *   and `upload.role` (primary/secondary).
 * - `upload.copies.failure` — per failed copy attempt, attributed by
 *   `upload.spId`, `upload.role`, and `upload.step` (which sub-step of the
 *   upload pipeline tripped the failure).
 *
 * Works in both Node and the browser. In Node, configuration is read from
 * environment variables (`FILECOIN_PIN_TELEMETRY_DISABLED`, `DO_NOT_TRACK`,
 * `FILECOIN_PIN_OTLP_METRICS_ENDPOINT`, `FILECOIN_PIN_OTLP_METRICS_TOKEN`).
 * In the browser, callers may use {@link configureTelemetry} to override the
 * defaults or disable telemetry entirely before invoking `executeUpload`.
 *
 * Metrics are batched in memory and exported every 60 seconds. A final flush
 * happens automatically when the host's lifecycle is ending: `beforeExit` in
 * Node and `pagehide` in the browser. Long-running consumers that terminate
 * via `process.exit()` or signals should call {@link shutdownTelemetry}
 * explicitly.
 */

import type { UploadResult } from '@filoz/synapse-sdk'
import type { Counter } from '@opentelemetry/api'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import {
  DEFAULT_OTLP_METRICS_ENDPOINT,
  DEFAULT_OTLP_METRICS_TOKEN,
  METRIC_UPLOAD_COPIES_FAILURE,
  METRIC_UPLOAD_COPIES_SUCCESS,
  TELEMETRY_SERVICE_NAME,
} from './constants.js'

interface TelemetryConfig {
  enabled: boolean
  endpoint: string
  token: string
}

interface TelemetryState {
  provider: MeterProvider
  reader: PeriodicExportingMetricReader
  successCounter: Counter
  failureCounter: Counter
}

/** Runtime-level overrides applied on top of env-var defaults. */
interface RuntimeOverrides {
  disabled?: boolean
  endpoint?: string
  token?: string
}

let state: TelemetryState | null = null
let disabled = false
let runtimeOverrides: RuntimeOverrides = {}
let beforeExitListener: (() => void) | null = null
let pageHideListener: (() => void) | null = null

/** True when running under Node (or another runtime with a compatible process). */
function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && typeof process.once === 'function'
}

/**
 * Configure telemetry at runtime. Intended for browser consumers, where env
 * vars aren't available — but works in Node too (overrides take precedence
 * over env vars). Must be called before the first `executeUpload`; calling
 * it after telemetry has initialized has no effect on the active session.
 */
export function configureTelemetry(overrides: RuntimeOverrides): void {
  runtimeOverrides = { ...runtimeOverrides, ...overrides }
}

function readConfig(): TelemetryConfig {
  const env = isNodeRuntime() ? process.env : ({} as NodeJS.ProcessEnv)

  // Match the existing Sentry instrumentation in src/instrument.ts so that
  // a single env var disables all telemetry. DO_NOT_TRACK is honoured as
  // the standard cross-tool opt-out. Runtime override beats both.
  const envDisabled = env.FILECOIN_PIN_TELEMETRY_DISABLED === 'true'
  const doNotTrack = env.DO_NOT_TRACK === '1' || env.DO_NOT_TRACK?.toLowerCase() === 'true'
  const enabled = runtimeOverrides.disabled !== true && !envDisabled && !doNotTrack

  const endpoint = runtimeOverrides.endpoint ?? env.FILECOIN_PIN_OTLP_METRICS_ENDPOINT ?? DEFAULT_OTLP_METRICS_ENDPOINT
  const token = runtimeOverrides.token ?? env.FILECOIN_PIN_OTLP_METRICS_TOKEN ?? DEFAULT_OTLP_METRICS_TOKEN
  return { enabled, endpoint, token }
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
    // it fires for tab close, navigation, and bfcache eviction. We register
    // with `once` so the listener cleans itself up after firing.
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

function initialize(): TelemetryState | null {
  if (state != null) return state
  if (disabled) return null

  const config = readConfig()
  if (!config.enabled) {
    disabled = true
    return null
  }

  const exporter = new OTLPMetricExporter({
    url: config.endpoint,
    headers: {
      Authorization: `Bearer ${config.token}`,
    },
  })

  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000,
  })

  const provider = new MeterProvider({
    resource: resourceFromAttributes({
      'service.name': TELEMETRY_SERVICE_NAME,
    }),
    readers: [reader],
  })

  const meter = provider.getMeter(TELEMETRY_SERVICE_NAME)
  const successCounter = meter.createCounter(METRIC_UPLOAD_COPIES_SUCCESS, {
    description: 'Number of copies successfully uploaded',
  })
  const failureCounter = meter.createCounter(METRIC_UPLOAD_COPIES_FAILURE, {
    description: 'Number of copy upload errors',
  })

  state = { provider, reader, successCounter, failureCounter }

  // Library consumers may not know to call shutdownTelemetry(). When the
  // host's lifecycle is ending naturally, flush before exit so the periodic
  // batch isn't lost. Long-running consumers that terminate via
  // `process.exit()` or signals should still call shutdownTelemetry()
  // explicitly on graceful shutdown.
  registerExitHandler()

  return state
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
  const initialized = initialize()
  if (initialized == null) return

  for (const copy of result.copies) {
    initialized.successCounter.add(1, {
      'upload.spId': String(copy.providerId),
      'upload.role': copy.role,
      network,
    })
  }
  for (const attempt of result.failedAttempts) {
    initialized.failureCounter.add(1, {
      'upload.spId': String(attempt.providerId),
      'upload.role': attempt.role,
      'upload.step': classifyStep(attempt.error),
      network,
    })
  }
}

/**
 * Flush pending metrics to the exporter. Call at process exit or when the
 * caller wants to guarantee delivery before continuing. Safe when disabled.
 */
export async function flushTelemetry(): Promise<void> {
  if (state == null) return
  await state.provider.forceFlush()
}

/**
 * Shut down the meter provider. Subsequent record calls become no-ops.
 * Intended for tests and long-lived hosts that need clean teardown.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (state == null) return
  unregisterExitHandler()
  await state.provider.shutdown()
  state = null
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
  state = null
  disabled = false
  runtimeOverrides = {}
}
