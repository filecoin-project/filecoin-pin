import type { CopyResult, FailedAttempt } from '@filoz/synapse-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface MockExporter {
  export: ReturnType<typeof vi.fn>
  forceFlush: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
  options: { url?: string; headers?: Record<string, string> } | undefined
}

const exporterInstances: MockExporter[] = []

vi.mock('@opentelemetry/exporter-metrics-otlp-http', () => {
  class OTLPMetricExporter {
    export = vi.fn((_metrics: unknown, cb: (result: { code: number }) => void) => cb({ code: 0 }))
    forceFlush = vi.fn().mockResolvedValue(undefined)
    shutdown = vi.fn().mockResolvedValue(undefined)
    options: MockExporter['options']
    constructor(opts: MockExporter['options']) {
      this.options = opts
      exporterInstances.push(this as unknown as MockExporter)
    }
  }
  return { OTLPMetricExporter }
})

const makeCopy = (overrides: Partial<CopyResult>): CopyResult => ({
  providerId: 1n,
  dataSetId: 10n,
  pieceId: 100n,
  role: 'primary',
  retrievalUrl: 'https://example/piece',
  isNewDataSet: false,
  ...overrides,
})

const makeAttempt = (overrides: Partial<FailedAttempt>): FailedAttempt => ({
  providerId: 2n,
  role: 'secondary',
  error: 'Pull failed',
  explicit: false,
  ...overrides,
})

async function freshTelemetry() {
  // Reset module state so each test gets a clean singleton
  vi.resetModules()
  exporterInstances.length = 0
  const mod = await import('../../core/telemetry/index.js')
  return mod
}

describe('telemetry', () => {
  afterEach(async () => {
    const { shutdownTelemetry } = await import('../../core/telemetry/index.js')
    await shutdownTelemetry()
  })

  it('records one success per copy and one failure per failed attempt', async () => {
    const { recordUploadResult, flushTelemetry } = await freshTelemetry()

    recordUploadResult(
      {
        copies: [makeCopy({ providerId: 1n, role: 'primary' }), makeCopy({ providerId: 2n, role: 'secondary' })],
        failedAttempts: [
          makeAttempt({ providerId: 3n, role: 'secondary', error: 'Pull failed for 1 piece(s)' }),
          makeAttempt({ providerId: 4n, role: 'secondary', error: 'Commit failed' }),
        ],
      },
      'calibration'
    )

    await flushTelemetry()

    expect(exporterInstances).toHaveLength(1)
    const exporter = exporterInstances[0]
    if (exporter == null) throw new Error('expected exporter instance')
    expect(exporter.export).toHaveBeenCalled()

    // Aggregate all data points across all export() invocations.
    const dataPoints: Array<{ name: string; attrs: Record<string, unknown>; value: number }> = []
    for (const call of exporter.export.mock.calls) {
      const batch = call[0]
      for (const scope of batch.scopeMetrics) {
        for (const metric of scope.metrics) {
          for (const dp of metric.dataPoints) {
            dataPoints.push({
              name: metric.descriptor.name,
              attrs: dp.attributes ?? {},
              value: dp.value,
            })
          }
        }
      }
    }

    const successPoints = dataPoints.filter((p) => p.name === 'upload.copies.success')
    const failurePoints = dataPoints.filter((p) => p.name === 'upload.copies.failure')

    expect(successPoints).toHaveLength(2)
    expect(successPoints).toContainEqual(
      expect.objectContaining({
        value: 1,
        attrs: expect.objectContaining({ 'upload.spId': '1', 'upload.role': 'primary', network: 'calibration' }),
      })
    )
    expect(successPoints).toContainEqual(
      expect.objectContaining({
        value: 1,
        attrs: expect.objectContaining({ 'upload.spId': '2', 'upload.role': 'secondary', network: 'calibration' }),
      })
    )

    expect(failurePoints).toHaveLength(2)
    expect(failurePoints).toContainEqual(
      expect.objectContaining({
        value: 1,
        attrs: expect.objectContaining({
          'upload.spId': '3',
          'upload.role': 'secondary',
          'upload.step': 'pull',
          network: 'calibration',
        }),
      })
    )
    expect(failurePoints).toContainEqual(
      expect.objectContaining({
        value: 1,
        attrs: expect.objectContaining({
          'upload.spId': '4',
          'upload.role': 'secondary',
          'upload.step': 'commit',
          network: 'calibration',
        }),
      })
    )
  })

  it('classifies unknown error strings as step=unknown', async () => {
    const { recordUploadResult, flushTelemetry } = await freshTelemetry()

    recordUploadResult(
      {
        copies: [],
        failedAttempts: [makeAttempt({ providerId: 9n, role: 'primary', error: 'Some other error' })],
      },
      'mainnet'
    )
    await flushTelemetry()

    const exporter = exporterInstances[0]
    if (exporter == null) throw new Error('expected exporter instance')
    const attrs = exporter.export.mock.calls
      .flatMap((c) => c[0].scopeMetrics)
      .flatMap((s: any) => s.metrics)
      .flatMap((m: any) => m.dataPoints)
      .map((dp: any) => dp.attributes)
    expect(attrs).toContainEqual(
      expect.objectContaining({ 'upload.spId': '9', 'upload.role': 'primary', 'upload.step': 'unknown' })
    )
  })

  it("flushes on the host process's beforeExit", async () => {
    const before = process.listenerCount('beforeExit')
    const { recordUploadResult } = await freshTelemetry()

    recordUploadResult({ copies: [makeCopy({ providerId: 7n })], failedAttempts: [] }, 'calibration')
    expect(process.listenerCount('beforeExit')).toBe(before + 1)

    process.emit('beforeExit', 0)
    // shutdownTelemetry is scheduled via `void`; let microtasks settle.
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    const exporter = exporterInstances[0]
    if (exporter == null) throw new Error('expected exporter instance')
    expect(exporter.shutdown).toHaveBeenCalled()
    expect(process.listenerCount('beforeExit')).toBe(before)
  })

  it('removes the beforeExit listener when shutdownTelemetry is called explicitly', async () => {
    const before = process.listenerCount('beforeExit')
    const { recordUploadResult, shutdownTelemetry } = await freshTelemetry()

    recordUploadResult({ copies: [makeCopy({})], failedAttempts: [] }, 'calibration')
    expect(process.listenerCount('beforeExit')).toBe(before + 1)

    await shutdownTelemetry()
    expect(process.listenerCount('beforeExit')).toBe(before)
  })

  it('honours configureTelemetry({ disabled: true }) without env vars', async () => {
    const { configureTelemetry, recordUploadResult, flushTelemetry } = await freshTelemetry()
    configureTelemetry({ disabled: true })

    recordUploadResult({ copies: [makeCopy({})], failedAttempts: [] }, 'calibration')
    await flushTelemetry()

    expect(exporterInstances).toHaveLength(0)
  })

  it('honours configureTelemetry endpoint/token overrides', async () => {
    const { configureTelemetry, recordUploadResult, flushTelemetry } = await freshTelemetry()

    configureTelemetry({ endpoint: 'https://example.test/v1/metrics', token: 'override-token' })
    recordUploadResult({ copies: [makeCopy({})], failedAttempts: [] }, 'calibration')
    await flushTelemetry()

    const exporter = exporterInstances[0]
    if (exporter == null) throw new Error('expected exporter instance')
    expect(exporter.options?.url).toBe('https://example.test/v1/metrics')
    expect(exporter.options?.headers?.Authorization).toBe('Bearer override-token')
  })
})

describe('telemetry (browser runtime)', () => {
  const realProcess = globalThis.process
  const addedListeners: Array<{ type: string; listener: EventListenerOrEventListenerObject; opts?: any }> = []
  const removedListeners: Array<{ type: string; listener: EventListenerOrEventListenerObject }> = []
  const realAddEventListener = (globalThis as { addEventListener?: typeof addEventListener }).addEventListener
  const realRemoveEventListener = (globalThis as { removeEventListener?: typeof removeEventListener })
    .removeEventListener

  beforeEach(() => {
    // Simulate a browser: no `process`, but DOM-style event listeners available.
    ;(globalThis as { process?: unknown }).process = undefined
    addedListeners.length = 0
    removedListeners.length = 0
    ;(globalThis as { addEventListener?: typeof addEventListener }).addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      opts?: any
    ) => {
      addedListeners.push({ type, listener, opts })
    }) as typeof addEventListener
    ;(globalThis as { removeEventListener?: typeof removeEventListener }).removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject
    ) => {
      removedListeners.push({ type, listener })
    }) as typeof removeEventListener
  })

  afterEach(async () => {
    // Restore Node globals so other tests run normally.
    ;(globalThis as { process?: unknown }).process = realProcess
    if (realAddEventListener) {
      ;(globalThis as { addEventListener?: typeof addEventListener }).addEventListener = realAddEventListener
    } else {
      delete (globalThis as { addEventListener?: unknown }).addEventListener
    }
    if (realRemoveEventListener) {
      ;(globalThis as { removeEventListener?: typeof removeEventListener }).removeEventListener =
        realRemoveEventListener
    } else {
      delete (globalThis as { removeEventListener?: unknown }).removeEventListener
    }
  })

  it('initializes without a Node process and registers a pagehide handler', async () => {
    const { recordUploadResult } = await freshTelemetry()

    recordUploadResult({ copies: [makeCopy({ providerId: 5n })], failedAttempts: [] }, 'mainnet')

    expect(exporterInstances).toHaveLength(1)
    const pagehide = addedListeners.find((l) => l.type === 'pagehide')
    expect(pagehide).toBeDefined()
    expect(pagehide?.opts?.once).toBe(true)
  })

  it('flushes via the pagehide listener and unregisters on explicit shutdown', async () => {
    const { recordUploadResult, shutdownTelemetry } = await freshTelemetry()

    recordUploadResult({ copies: [makeCopy({})], failedAttempts: [] }, 'mainnet')
    await shutdownTelemetry()

    const exporter = exporterInstances[0]
    if (exporter == null) throw new Error('expected exporter instance')
    expect(exporter.shutdown).toHaveBeenCalled()
    expect(removedListeners.some((l) => l.type === 'pagehide')).toBe(true)
  })
})
