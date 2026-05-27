import type { CopyResult, FailedAttempt } from '@filoz/synapse-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface FetchCall {
  url: string
  init: RequestInit
}

interface MetricPayload {
  name: string
  counter: { value: number }
  dt: string
  tags: Record<string, string>
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

function parseBody(call: FetchCall): MetricPayload[] {
  if (typeof call.init.body !== 'string') throw new Error('expected JSON string body')
  return JSON.parse(call.init.body)
}

function firstCall(): FetchCall {
  const call = fetchCalls[0]
  if (call == null) throw new Error('expected at least one fetch call')
  return call
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

  it('posts one uploadCopyStatus point per copy and per failed attempt in a single request', async () => {
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
    expect(points).toHaveLength(4)

    for (const point of points) {
      expect(point.name).toBe('uploadCopyStatus')
      expect(point.tags.affordance).toBe('Library')
      expect(typeof point.dt).toBe('string')
    }

    expect(points).toContainEqual(
      expect.objectContaining({
        counter: { value: 1 },
        tags: expect.objectContaining({
          spId: '1',
          role: 'primary',
          value: 'success',
          network: 'calibration',
        }),
      })
    )
    expect(points).toContainEqual(
      expect.objectContaining({
        counter: { value: 1 },
        tags: expect.objectContaining({
          spId: '2',
          role: 'secondary',
          value: 'success',
          network: 'calibration',
        }),
      })
    )
    expect(points).toContainEqual(
      expect.objectContaining({
        counter: { value: 1 },
        tags: expect.objectContaining({
          spId: '3',
          role: 'secondary',
          value: 'failure.pull',
          network: 'calibration',
        }),
      })
    )
    expect(points).toContainEqual(
      expect.objectContaining({
        counter: { value: 1 },
        tags: expect.objectContaining({
          spId: '4',
          role: 'secondary',
          value: 'failure.commit',
          network: 'calibration',
        }),
      })
    )
  })

  it('stamps the configured affordance on every point', async () => {
    const { configureTelemetry, recordUploadResult, flushTelemetry } = await freshTelemetry()
    configureTelemetry({ affordance: 'CLI' })

    recordUploadResult(
      {
        copies: [makeCopy({})],
        failedAttempts: [makeAttempt({})],
      },
      'mainnet'
    )
    await flushTelemetry()

    const points = parseBody(firstCall())
    for (const point of points) {
      expect(point.tags.affordance).toBe('CLI')
    }
  })

  it.each([
    'CLI',
    'GitHub Action',
    'Library',
    'Filecoin Pin Website',
  ] as const)('accepts %s as a valid affordance', async (affordance) => {
    const { configureTelemetry } = await freshTelemetry()
    expect(() => configureTelemetry({ affordance })).not.toThrow()
  })

  it('throws when configureTelemetry is given an invalid affordance', async () => {
    const { configureTelemetry } = await freshTelemetry()
    expect(() => configureTelemetry({ affordance: 'webapp' as never })).toThrow(/Invalid telemetry affordance/)
  })

  it('fires one request per recordUploadResult call', async () => {
    const { recordUploadResult, flushTelemetry } = await freshTelemetry()

    recordUploadResult({ copies: [makeCopy({})], failedAttempts: [] }, 'mainnet')
    recordUploadResult({ copies: [makeCopy({})], failedAttempts: [] }, 'mainnet')
    await flushTelemetry()

    expect(fetchCalls).toHaveLength(2)
  })

  it('skips the request entirely when there is nothing to record', async () => {
    const { recordUploadResult, flushTelemetry } = await freshTelemetry()

    recordUploadResult({ copies: [], failedAttempts: [] }, 'mainnet')
    await flushTelemetry()

    expect(fetchCalls).toHaveLength(0)
  })

  it('classifies unrecognised failure strings as value=failure.other', async () => {
    const { recordUploadResult, flushTelemetry } = await freshTelemetry()

    recordUploadResult(
      { copies: [], failedAttempts: [makeAttempt({ providerId: 9n, role: 'primary', error: 'Some other error' })] },
      'mainnet'
    )
    await flushTelemetry()

    const points = parseBody(firstCall())
    expect(points[0]?.tags).toMatchObject({
      spId: '9',
      role: 'primary',
      value: 'failure.other',
    })
  })

  it('posts to the default BetterStack endpoint with a bearer token', async () => {
    const { recordUploadResult, flushTelemetry } = await freshTelemetry()

    recordUploadResult({ copies: [makeCopy({})], failedAttempts: [] }, 'calibration')
    await flushTelemetry()

    const call = firstCall()
    expect(call.url).toMatch(/^https:\/\/.*betterstackdata\.com\/metrics$/)
    expect(call.init.method).toBe('POST')
    const headers = call.init.headers as Record<string, string>
    expect(headers.Authorization).toMatch(/^Bearer .+/)
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('honours configureTelemetry({ disabled: true })', async () => {
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

    const call = firstCall()
    expect(call.url).toBe('https://example.test/metrics')
    expect((call.init.headers as Record<string, string>).Authorization).toBe('Bearer override-token')
  })

  it('shutdownTelemetry awaits in-flight requests and disables subsequent calls', async () => {
    const { recordUploadResult, shutdownTelemetry } = await freshTelemetry()

    let resolveFetch: (() => void) | undefined
    fetchMock.mockImplementationOnce(async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, init })
      await new Promise<void>((r) => {
        resolveFetch = r
      })
      return new Response(null, { status: 202 })
    })

    recordUploadResult({ copies: [makeCopy({})], failedAttempts: [] }, 'mainnet')

    const shutdown = shutdownTelemetry()
    // Shutdown should not resolve until the in-flight fetch completes.
    let settled = false
    void shutdown.then(() => {
      settled = true
    })
    await new Promise((r) => setImmediate(r))
    expect(settled).toBe(false)

    resolveFetch?.()
    await shutdown
    expect(settled).toBe(true)

    // Subsequent calls are no-ops.
    recordUploadResult({ copies: [makeCopy({})], failedAttempts: [] }, 'mainnet')
    expect(fetchCalls).toHaveLength(1)
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
