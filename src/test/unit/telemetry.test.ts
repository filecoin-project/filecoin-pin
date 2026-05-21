import type { CopyResult, FailedAttempt } from '@filoz/synapse-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const exporterInstances: Array<{
  export: ReturnType<typeof vi.fn>
  forceFlush: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
}> = []

vi.mock('@opentelemetry/exporter-metrics-otlp-http', () => {
  class OTLPMetricExporter {
    export = vi.fn((_metrics: unknown, cb: (result: { code: number }) => void) => cb({ code: 0 }))
    forceFlush = vi.fn().mockResolvedValue(undefined)
    shutdown = vi.fn().mockResolvedValue(undefined)
    constructor() {
      exporterInstances.push(this as unknown as (typeof exporterInstances)[number])
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
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.FILECOIN_PIN_TELEMETRY_DISABLED
    delete process.env.DO_NOT_TRACK
    delete process.env.FILECOIN_PIN_OTLP_METRICS_ENDPOINT
    delete process.env.FILECOIN_PIN_OTLP_METRICS_TOKEN
  })

  afterEach(async () => {
    const { shutdownTelemetry } = await import('../../core/telemetry/index.js')
    await shutdownTelemetry()
    process.env = originalEnv
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

  it('FILECOIN_PIN_TELEMETRY_DISABLED=true short-circuits initialization', async () => {
    process.env.FILECOIN_PIN_TELEMETRY_DISABLED = 'true'
    const { recordUploadResult, flushTelemetry } = await freshTelemetry()

    recordUploadResult({ copies: [makeCopy({})], failedAttempts: [] }, 'calibration')
    await flushTelemetry()

    expect(exporterInstances).toHaveLength(0)
  })

  it('DO_NOT_TRACK=1 short-circuits initialization', async () => {
    process.env.DO_NOT_TRACK = '1'
    const { recordUploadResult, flushTelemetry } = await freshTelemetry()

    recordUploadResult({ copies: [makeCopy({})], failedAttempts: [] }, 'calibration')
    await flushTelemetry()

    expect(exporterInstances).toHaveLength(0)
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
})
