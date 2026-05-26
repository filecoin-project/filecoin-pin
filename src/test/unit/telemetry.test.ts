import type { CopyResult, FailedAttempt } from '@filoz/synapse-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FetchCall {
  url: string
  init: RequestInit
}

const fetchCalls: FetchCall[] = []
let fetchMock: ReturnType<typeof vi.fn>

function installFetch(): void {
  fetchCalls.length = 0
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init })
    return new Response(null, { status: 202 })
  })
  ;(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch
}

interface MetricPayload {
  name: string
  counter: { value: number }
  dt: string
  tags: Record<string, string>
}

function parseBody(call: FetchCall): MetricPayload[] {
  if (typeof call.init.body !== 'string') throw new Error('expected JSON string body')
  return JSON.parse(call.init.body)
}

function firstCall(): FetchCall {
  const call = fetchCalls[0]
  if (call == null) throw new Error('expected at least one fetch call')
  return call
}

function firstPoint(points: MetricPayload[]): MetricPayload {
  const point = points[0]
  if (point == null) throw new Error('expected at least one metric point')
  return point
}

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
  vi.resetModules()
  installFetch()
  return import('../../core/telemetry/index.js')
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

    expect(fetchCalls).toHaveLength(1)
    const points = parseBody(firstCall())

    const successPoints = points.filter((p) => p.name === 'upload.copies.success')
    const failurePoints = points.filter((p) => p.name === 'upload.copies.failure')

    expect(successPoints).toHaveLength(2)
    expect(successPoints).toContainEqual(
      expect.objectContaining({
        counter: { value: 1 },
        tags: expect.objectContaining({ 'upload.spId': '1', 'upload.role': 'primary', network: 'calibration' }),
      })
    )
    expect(successPoints).toContainEqual(
      expect.objectContaining({
        counter: { value: 1 },
        tags: expect.objectContaining({ 'upload.spId': '2', 'upload.role': 'secondary', network: 'calibration' }),
      })
    )

    expect(failurePoints).toHaveLength(2)
    expect(failurePoints).toContainEqual(
      expect.objectContaining({
        counter: { value: 1 },
        tags: expect.objectContaining({
          'upload.spId': '3',
          'upload.role': 'secondary',
          'upload.step': 'pull',
          network: 'calibration',
        }),
      })
    )
    expect(failurePoints).toContainEqual(
      expect.objectContaining({
        counter: { value: 1 },
        tags: expect.objectContaining({
          'upload.spId': '4',
          'upload.role': 'secondary',
          'upload.step': 'commit',
          network: 'calibration',
        }),
      })
    )
    for (const point of points) {
      expect(point.tags['service.name']).toBe('filecoin-pin')
      expect(typeof point.dt).toBe('string')
    }
  })

  it('aggregates repeated events for the same metric+tag set', async () => {
    const { recordUploadResult, flushTelemetry } = await freshTelemetry()

    recordUploadResult(
      {
        copies: [
          makeCopy({ providerId: 1n, role: 'primary' }),
          makeCopy({ providerId: 1n, role: 'primary' }),
          makeCopy({ providerId: 1n, role: 'primary' }),
        ],
        failedAttempts: [],
      },
      'mainnet'
    )
    await flushTelemetry()

    expect(fetchCalls).toHaveLength(1)
    const points = parseBody(firstCall())
    expect(points).toHaveLength(1)
    expect(firstPoint(points).counter.value).toBe(3)
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

    const points = parseBody(firstCall())
    expect(firstPoint(points).tags).toMatchObject({
      'upload.spId': '9',
      'upload.role': 'primary',
      'upload.step': 'unknown',
    })
  })

  it('posts to the default BetterStack endpoint with a bearer token', async () => {
    const { recordUploadResult, flushTelemetry } = await freshTelemetry()

    recordUploadResult({ copies: [makeCopy({})], failedAttempts: [] }, 'calibration')
    await flushTelemetry()

    expect(fetchCalls).toHaveLength(1)
    const call = firstCall()
    expect(call.url).toMatch(/^https:\/\/.*betterstackdata\.com\/metrics$/)
    expect(call.init.method).toBe('POST')
    const headers = call.init.headers as Record<string, string>
    expect(headers.Authorization).toMatch(/^Bearer .+/)
    expect(headers['Content-Type']).toBe('application/json')
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

    expect(fetchCalls).toHaveLength(1)
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

    expect(fetchCalls).toHaveLength(0)
  })

  it('honours configureTelemetry endpoint/token overrides', async () => {
    const { configureTelemetry, recordUploadResult, flushTelemetry } = await freshTelemetry()

    configureTelemetry({ endpoint: 'https://example.test/metrics', token: 'override-token' })
    recordUploadResult({ copies: [makeCopy({})], failedAttempts: [] }, 'calibration')
    await flushTelemetry()

    expect(fetchCalls).toHaveLength(1)
    const call = firstCall()
    expect(call.url).toBe('https://example.test/metrics')
    expect((call.init.headers as Record<string, string>).Authorization).toBe('Bearer override-token')
  })

  it('swallows fetch errors so telemetry never breaks the host', async () => {
    const { recordUploadResult, flushTelemetry } = await freshTelemetry()
    fetchMock.mockImplementation(async () => {
      throw new Error('network down')
    })

    recordUploadResult({ copies: [makeCopy({})], failedAttempts: [] }, 'calibration')
    await expect(flushTelemetry()).resolves.toBeUndefined()
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

    const pagehide = addedListeners.find((l) => l.type === 'pagehide')
    expect(pagehide).toBeDefined()
    expect(pagehide?.opts?.once).toBe(true)
  })

  it('flushes via shutdown and unregisters the pagehide listener', async () => {
    const { recordUploadResult, shutdownTelemetry } = await freshTelemetry()

    recordUploadResult({ copies: [makeCopy({})], failedAttempts: [] }, 'mainnet')
    await shutdownTelemetry()

    expect(fetchCalls).toHaveLength(1)
    expect(removedListeners.some((l) => l.type === 'pagehide')).toBe(true)
  })
})
