import type { PDPProvider } from '@filoz/synapse-sdk'
import { CID } from 'multiformats/cid'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkIpniIndexer,
  IndexerMismatchError,
  waitForIndexingConfirmation,
  waitForIpniProviderResults,
} from '../../core/utils/validate-ipni-advertisement.js'

const createPDPProvider = (serviceURL: string): PDPProvider =>
  ({
    id: 1234n,
    serviceProvider: 'f01234',
    name: 'Test Provider',
    description: '',
    isActive: true,
    payee: '0x0000000000000000000000000000000000000000',
    pdp: {
      serviceURL,
    },
  }) as unknown as PDPProvider

const successResponse = (multiaddrs: string[] = ['/dns/example.com/tcp/443/https']) => ({
  ok: true,
  json: vi.fn(async () => ({
    MultihashResults: [
      {
        ProviderResults: multiaddrs.map((addr, index) => ({
          Provider: {
            ID: `12D3KooWProvider${index}`,
            Addrs: [addr],
          },
        })),
      },
    ],
  })),
})

const emptyProviderResponse = () => ({
  ok: true,
  json: vi.fn(async () => ({
    MultihashResults: [],
  })),
})

const pieceStatusResponse = (synced: boolean) => ({
  ok: true,
  json: vi.fn(async () => ({ synced })),
})

describe('checkIpniIndexer', () => {
  const testCid = CID.parse('bafkreia5fn4rmshmb7cl7fufkpcw733b5anhuhydtqstnglpkzosqln5kq')
  const defaultIndexerUrl = 'https://cid.contact'
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  describe('successful announcement', () => {
    it('should resolve true and emit a final complete event on first attempt', async () => {
      mockFetch.mockResolvedValueOnce(successResponse())
      const onProgress = vi.fn()

      const promise = checkIpniIndexer(testCid, { ipniIndexerUrl: defaultIndexerUrl, onProgress })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledWith(`${defaultIndexerUrl}/cid/${testCid}`, {
        headers: { Accept: 'application/json' },
      })

      // Should emit retryUpdate for attempt 0 and a final complete(true)
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ipniProviderResults:retryUpdate',
          data: expect.objectContaining({ retryCount: 0 }),
        })
      )
      expect(onProgress).toHaveBeenCalledWith({
        type: 'ipniProviderResults:complete',
        data: { result: true, retryCount: 0 },
      })
    })

    it('should retry multiple times before succeeding and emit a final complete(true)', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce(successResponse())

      const onProgress = vi.fn()
      const promise = checkIpniIndexer(testCid, { ipniIndexerUrl: defaultIndexerUrl, maxAttempts: 5, onProgress })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(4)

      // Expect retryUpdate with counts 0,1,2,3 and final complete after all checks
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ipniProviderResults:retryUpdate',
          data: expect.objectContaining({ retryCount: 0 }),
        })
      )
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ipniProviderResults:retryUpdate',
          data: expect.objectContaining({ retryCount: 1 }),
        })
      )
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ipniProviderResults:retryUpdate',
          data: expect.objectContaining({ retryCount: 2 }),
        })
      )
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ipniProviderResults:retryUpdate',
          data: expect.objectContaining({ retryCount: 3 }),
        })
      )
      expect(onProgress).toHaveBeenCalledWith({
        type: 'ipniProviderResults:complete',
        data: { result: true, retryCount: 3 },
      })
    })

    it('should succeed when the expected provider advertises the derived multiaddr', async () => {
      const provider = createPDPProvider('https://example.com')
      const expectedMultiaddr = '/dns/example.com/tcp/443/https'
      mockFetch.mockResolvedValueOnce(successResponse([expectedMultiaddr]))

      const promise = checkIpniIndexer(testCid, { ipniIndexerUrl: defaultIndexerUrl, expectedProviders: [provider] })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(`${defaultIndexerUrl}/cid/${testCid}`, {
        headers: { Accept: 'application/json' },
      })
    })

    it('should succeed when IPNI returns short-form multiaddr without /tcp (Curio git_88428906+)', async () => {
      const provider = createPDPProvider('https://example.com')
      // Curio now advertises /dns/host/https instead of /dns/host/tcp/443/https
      mockFetch.mockResolvedValueOnce(successResponse(['/dns/example.com/https']))

      const promise = checkIpniIndexer(testCid, { ipniIndexerUrl: defaultIndexerUrl, expectedProviders: [provider] })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
    })

    it('should succeed when IPNI returns short-form http multiaddr', async () => {
      const provider = createPDPProvider('http://example.com')
      mockFetch.mockResolvedValueOnce(successResponse(['/dns/example.com/http']))

      const promise = checkIpniIndexer(testCid, { ipniIndexerUrl: defaultIndexerUrl, expectedProviders: [provider] })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
    })

    it('should succeed when multiaddr includes http-path and matches service URL path', async () => {
      const provider = createPDPProvider('https://example.com/api/v1')
      mockFetch.mockResolvedValueOnce(successResponse(['/dns/example.com/tcp/443/https/http-path/api%2Fv1']))

      const promise = checkIpniIndexer(testCid, { ipniIndexerUrl: defaultIndexerUrl, expectedProviders: [provider] })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
    })

    it('should succeed when short-form multiaddr includes http-path', async () => {
      const provider = createPDPProvider('https://example.com/api/v1')
      mockFetch.mockResolvedValueOnce(successResponse(['/dns/example.com/https/http-path/api%2Fv1']))

      const promise = checkIpniIndexer(testCid, { ipniIndexerUrl: defaultIndexerUrl, expectedProviders: [provider] })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
    })

    it('should match when service URL has trailing slash (normalized away for comparison)', async () => {
      const provider = createPDPProvider('https://example.com/api/v1/')
      // multiaddrToUri strips trailing slashes, so both sides normalize to https://example.com/api/v1
      mockFetch.mockResolvedValueOnce(successResponse(['/dns/example.com/https/http-path/api%2Fv1']))

      const promise = checkIpniIndexer(testCid, { ipniIndexerUrl: defaultIndexerUrl, expectedProviders: [provider] })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
    })

    it('should succeed when all expected providers are in the IPNI ProviderResults', async () => {
      const providerA = createPDPProvider('https://a.example.com')
      const providerB = createPDPProvider('https://b.example.com:8443')
      const expectedMultiaddrs = ['/dns/a.example.com/tcp/443/https', '/dns/b.example.com/tcp/8443/https']

      mockFetch.mockResolvedValueOnce(successResponse(expectedMultiaddrs))

      const promise = checkIpniIndexer(testCid, {
        ipniIndexerUrl: defaultIndexerUrl,
        expectedProviders: [providerA, providerB],
      })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
    })

    it('should validate child blocks and emit complete only after all pass', async () => {
      const childCid = CID.parse('bafkreia7wx2ue2r5x2bwsxns2r4jtrsu7dzw2r3abjtw3obqckm3w2b2mu')
      mockFetch.mockResolvedValueOnce(successResponse()).mockResolvedValueOnce(successResponse())
      const onProgress = vi.fn()

      const promise = checkIpniIndexer(testCid, {
        ipniIndexerUrl: defaultIndexerUrl,
        childBlocks: [childCid],
        onProgress,
      })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(`${defaultIndexerUrl}/cid/${testCid}`, {
        headers: { Accept: 'application/json' },
      })
      expect(mockFetch).toHaveBeenCalledWith(`${defaultIndexerUrl}/cid/${childCid}`, {
        headers: { Accept: 'application/json' },
      })

      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ipniProviderResults:retryUpdate',
          data: expect.objectContaining({ retryCount: 0 }),
        })
      )
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ipniProviderResults:retryUpdate',
          data: expect.objectContaining({ retryCount: 1 }),
        })
      )
      const completeEvents = onProgress.mock.calls.filter(([event]) => event.type === 'ipniProviderResults:complete')
      expect(completeEvents).toHaveLength(1)
      expect(completeEvents[0]?.[0]).toEqual({
        type: 'ipniProviderResults:complete',
        data: { result: true, retryCount: 1 },
      })
    })
  })

  describe('failed announcement', () => {
    it('should fail when a child block does not validate after root succeeds', async () => {
      const childCid = CID.parse('bafkreia7wx2ue2r5x2bwsxns2r4jtrsu7dzw2r3abjtw3obqckm3w2b2mu')
      mockFetch.mockResolvedValueOnce(successResponse()).mockResolvedValueOnce({ ok: false })
      const onProgress = vi.fn()

      const promise = checkIpniIndexer(testCid, {
        ipniIndexerUrl: defaultIndexerUrl,
        childBlocks: [childCid],
        maxAttempts: 1,
        onProgress,
      })
      const expectPromise = expect(promise).rejects.toThrow(
        `IPFS CID "${childCid.toString()}" does not have expected IPNI ProviderResults after 1 attempt`
      )

      await vi.runAllTimersAsync()
      await expectPromise

      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ipniProviderResults:retryUpdate',
          data: expect.objectContaining({ retryCount: 0 }),
        })
      )
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ipniProviderResults:retryUpdate',
          data: expect.objectContaining({ retryCount: 1 }),
        })
      )
      expect(onProgress).toHaveBeenCalledWith({
        type: 'ipniProviderResults:failed',
        data: { error: expect.any(Error) },
      })
      expect(onProgress).not.toHaveBeenCalledWith({
        type: 'ipniProviderResults:complete',
        data: { result: true, retryCount: expect.any(Number) },
      })
    })

    it('should reject after custom maxAttempts and emit a failed event', async () => {
      mockFetch.mockResolvedValue({ ok: false })
      const onProgress = vi.fn()
      const promise = checkIpniIndexer(testCid, { ipniIndexerUrl: defaultIndexerUrl, maxAttempts: 3, onProgress })
      // Attach rejection handler immediately
      const expectPromise = expect(promise).rejects.toThrow(
        `IPFS CID "${testCid.toString()}" does not have expected IPNI ProviderResults after 3 attempts`
      )

      await vi.runAllTimersAsync()
      await expectPromise
      expect(mockFetch).toHaveBeenCalledTimes(3)

      // Expect retryUpdate with counts 0,1,2 and final failed event (no complete event on failure)
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ipniProviderResults:retryUpdate',
          data: expect.objectContaining({ retryCount: 0 }),
        })
      )
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ipniProviderResults:retryUpdate',
          data: expect.objectContaining({ retryCount: 1 }),
        })
      )
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ipniProviderResults:retryUpdate',
          data: expect.objectContaining({ retryCount: 2 }),
        })
      )
      // Should emit failed event, not complete(false)
      expect(onProgress).toHaveBeenCalledWith({
        type: 'ipniProviderResults:failed',
        data: { error: expect.any(Error) },
      })
      // Should NOT emit complete event
      expect(onProgress).not.toHaveBeenCalledWith({
        type: 'ipniProviderResults:complete',
        data: { result: false, retryCount: expect.any(Number) },
      })
    })

    it('should reject immediately when maxAttempts is 1', async () => {
      mockFetch.mockResolvedValue({ ok: false })

      const promise = checkIpniIndexer(testCid, { ipniIndexerUrl: defaultIndexerUrl, maxAttempts: 1 })
      // Attach rejection handler immediately
      const expectPromise = expect(promise).rejects.toThrow(
        `IPFS CID "${testCid.toString()}" does not have expected IPNI ProviderResults after 1 attempt`
      )

      await vi.runAllTimersAsync()
      await expectPromise
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
    it('should reject when an expected provider is missing from the  IPNI ProviderResults', async () => {
      const provider = createPDPProvider('https://expected.example.com')
      mockFetch.mockResolvedValueOnce(successResponse(['/dns/other.example.com/tcp/443/https']))

      const promise = checkIpniIndexer(testCid, {
        ipniIndexerUrl: defaultIndexerUrl,
        maxAttempts: 1,
        expectedProviders: [provider],
      })

      const expectPromise = expect(promise).rejects.toThrow(
        `IPFS CID "${testCid.toString()}" does not have expected IPNI ProviderResults after 1 attempt. Last observation: Missing expected provider(s): https://expected.example.com`
      )
      await vi.runAllTimersAsync()
      await expectPromise
    })

    it('should reject when not all expected providers are in the IPNI ProviderResults', async () => {
      const providerA = createPDPProvider('https://a.example.com')
      const providerB = createPDPProvider('https://b.example.com')
      mockFetch.mockResolvedValueOnce(successResponse(['/dns/a.example.com/tcp/443/https']))

      const promise = checkIpniIndexer(testCid, {
        ipniIndexerUrl: defaultIndexerUrl,
        maxAttempts: 1,
        expectedProviders: [providerA, providerB],
      })

      const expectPromise = expect(promise).rejects.toThrow(
        `IPFS CID "${testCid.toString()}" does not have expected IPNI ProviderResults after 1 attempt. Last observation: Missing expected provider(s): https://b.example.com`
      )
      await vi.runAllTimersAsync()
      await expectPromise
    })

    it('should retry until the expected provider appears in subsequent attempts', async () => {
      const provider = createPDPProvider('https://expected.example.com')
      const expectedMultiaddr = '/dns/expected.example.com/tcp/443/https'
      mockFetch
        .mockResolvedValueOnce(successResponse(['/dns/other.example.com/tcp/443/https']))
        .mockResolvedValueOnce(successResponse([expectedMultiaddr]))

      const promise = checkIpniIndexer(testCid, {
        ipniIndexerUrl: defaultIndexerUrl,
        maxAttempts: 3,
        expectedProviders: [provider],
        delayMs: 1,
      })

      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('should retry when the IPNI response is empty', async () => {
      const provider = createPDPProvider('https://expected.example.com')
      const expectedMultiaddr = '/dns/expected.example.com/tcp/443/https'
      mockFetch
        .mockResolvedValueOnce(emptyProviderResponse())
        .mockResolvedValueOnce(successResponse([expectedMultiaddr]))

      const promise = checkIpniIndexer(testCid, {
        ipniIndexerUrl: defaultIndexerUrl,
        maxAttempts: 3,
        expectedProviders: [provider],
        delayMs: 1,
      })

      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })
  })

  describe('abort signal', () => {
    it('should abort when signal is triggered before first check', async () => {
      const abortController = new AbortController()
      abortController.abort()

      const promise = checkIpniIndexer(testCid, { ipniIndexerUrl: defaultIndexerUrl, signal: abortController.signal })
      // Attach rejection handler immediately
      const expectPromise = expect(promise).rejects.toThrow('Check IPNI announce aborted')

      await vi.runAllTimersAsync()
      await expectPromise
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('should abort when signal is triggered during retry', async () => {
      const abortController = new AbortController()
      mockFetch.mockResolvedValue({ ok: false })

      const promise = checkIpniIndexer(testCid, {
        ipniIndexerUrl: defaultIndexerUrl,
        signal: abortController.signal,
        maxAttempts: 5,
      })

      // Let first check complete
      await vi.advanceTimersByTimeAsync(0)
      expect(mockFetch).toHaveBeenCalledTimes(1)

      // Abort before retry
      abortController.abort()

      // Attach rejection handler before running remaining timers
      const expectPromise = expect(promise).rejects.toThrow('Check IPNI announce aborted')
      await vi.runAllTimersAsync()
      await expectPromise

      // Should not make additional calls after abort
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('should pass abort signal to fetch when provided', async () => {
      const abortController = new AbortController()
      mockFetch.mockResolvedValueOnce(successResponse())

      const promise = checkIpniIndexer(testCid, { ipniIndexerUrl: defaultIndexerUrl, signal: abortController.signal })
      await vi.runAllTimersAsync()
      await promise

      expect(mockFetch).toHaveBeenCalledWith(`${defaultIndexerUrl}/cid/${testCid}`, {
        headers: { Accept: 'application/json' },
        signal: abortController.signal,
      })
    })
  })

  describe('edge cases', () => {
    it('should retry when fetch throws before succeeding within maxAttempts', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error')).mockResolvedValueOnce(successResponse())

      const promise = checkIpniIndexer(testCid, { ipniIndexerUrl: defaultIndexerUrl, maxAttempts: 2, delayMs: 1 })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('should handle different CID formats', async () => {
      const v0Cid = CID.parse('QmNT6isqrhH6LZWg8NeXQYTD9wPjJo2BHHzyezpf9BdHbD')
      mockFetch.mockResolvedValueOnce(successResponse())

      const promise = checkIpniIndexer(v0Cid, { ipniIndexerUrl: defaultIndexerUrl })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(`${defaultIndexerUrl}/cid/${v0Cid}`, {
        headers: { Accept: 'application/json' },
      })
    })

    it('should handle empty or missing provider data gracefully', async () => {
      // Test that validation handles various malformed provider responses
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn(async () => ({
          MultihashResults: [
            {
              ProviderResults: [
                { Provider: null }, // null provider
                { Provider: { ID: '12D3Koo1', Addrs: [] } }, // empty addrs
                { Provider: { ID: '12D3Koo2', Addrs: ['/dns/valid.com/tcp/443/https'] } }, // valid
              ],
            },
          ],
        })),
      })

      const promise = checkIpniIndexer(testCid, { ipniIndexerUrl: defaultIndexerUrl, maxAttempts: 1 })
      await vi.runAllTimersAsync()
      const result = await promise

      // Should succeed because at least one valid provider exists
      expect(result).toBe(true)
    })

    it('should handle provider without serviceURL by falling back to generic validation', async () => {
      const providerWithoutURL = {
        id: 1234n,
        serviceProvider: 'f01234',
        name: 'Test Provider',
        description: '',
        isActive: true,
        payee: '0x0000000000000000000000000000000000000000',
        pdp: {},
      } as unknown as PDPProvider

      mockFetch.mockResolvedValueOnce(successResponse())

      const promise = checkIpniIndexer(testCid, {
        ipniIndexerUrl: defaultIndexerUrl,
        expectedProviders: [providerWithoutURL],
      })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
    })

    it('should preserve parse error message instead of overwriting with generic message', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn(async () => {
          throw new Error('Invalid JSON')
        }),
      })

      const promise = checkIpniIndexer(testCid, { ipniIndexerUrl: defaultIndexerUrl, maxAttempts: 1 })
      // Should preserve the specific "Failed to parse" message, not overwrite with generic message
      const expectPromise = expect(promise).rejects.toThrow('Failed to parse IPNI response body')

      await vi.runAllTimersAsync()
      await expectPromise
    })

    it('should clear stale multiaddrs when parse error occurs after successful response', async () => {
      // Attempt 1: successful response with multiaddrs but doesn't match expectations
      // Attempt 2: parse error - should clear the multiaddrs from attempt 1
      const provider = createPDPProvider('https://expected.example.com')
      mockFetch.mockResolvedValueOnce(successResponse(['/dns/other.example.com/tcp/443/https'])).mockResolvedValueOnce({
        ok: true,
        json: vi.fn(async () => {
          throw new Error('Invalid JSON')
        }),
      })

      const promise = checkIpniIndexer(testCid, {
        ipniIndexerUrl: defaultIndexerUrl,
        maxAttempts: 2,
        expectedProviders: [provider],
      })

      const expectPromise = expect(promise).rejects.toThrow(
        `IPFS CID "${testCid.toString()}" does not have expected IPNI ProviderResults after 2 attempts. Last observation: Failed to parse IPNI response body: Invalid JSON. Expected serviceURLs: [https://expected.example.com]. Actual multiaddrs in response: []`
      )

      await vi.runAllTimersAsync()
      await expectPromise
    })

    it('should update failure reason on each attempt instead of preserving first error', async () => {
      // Attempt 1: parse error
      // Attempt 2: successful parse but empty results
      // Final error should report empty results as last observation, not parse error
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn(async () => {
            throw new Error('Invalid JSON')
          }),
        })
        .mockResolvedValueOnce(emptyProviderResponse())

      const promise = checkIpniIndexer(testCid, { ipniIndexerUrl: defaultIndexerUrl, maxAttempts: 2 })

      const expectPromise = expect(promise).rejects.toThrow(
        'Last observation: IPNI response did not include any provider results'
      )

      await vi.runAllTimersAsync()
      await expectPromise
    })

    it('should use custom IPNI indexer URL when provided', async () => {
      const customIndexerUrl = 'https://custom-indexer.example.com'
      mockFetch.mockResolvedValueOnce(successResponse())

      const promise = checkIpniIndexer(testCid, { ipniIndexerUrl: customIndexerUrl })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(`${customIndexerUrl}/cid/${testCid}`, {
        headers: { Accept: 'application/json' },
      })
    })
  })
})

describe('waitForIpniProviderResults (deprecated alias)', () => {
  it('is the same function as checkIpniIndexer', () => {
    expect(waitForIpniProviderResults).toBe(checkIpniIndexer)
  })
})

describe('waitForIndexingConfirmation', () => {
  const testCid = CID.parse('bafkreia5fn4rmshmb7cl7fufkpcw733b5anhuhydtqstnglpkzosqln5kq')
  const testPieceCid = CID.parse('bafkreia7wx2ue2r5x2bwsxns2r4jtrsu7dzw2r3abjtw3obqckm3w2b2mu')
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('should poll piece-status until synced, then confirm via the indexer', async () => {
    const provider = createPDPProvider('https://sp.example.com')
    mockFetch
      .mockResolvedValueOnce(pieceStatusResponse(false))
      .mockResolvedValueOnce(pieceStatusResponse(true))
      .mockResolvedValueOnce(successResponse(['/dns/sp.example.com/tcp/443/https']))
    const onProgress = vi.fn()

    const promise = waitForIndexingConfirmation(testCid, testPieceCid, {
      expectedProviders: [provider],
      onProgress,
    })
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result).toBe(true)
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      `https://sp.example.com/pdp/piece/${encodeURIComponent(testPieceCid.toString())}/status`,
      { headers: { Accept: 'application/json' }, signal: expect.any(AbortSignal) }
    )
    expect(mockFetch).toHaveBeenNthCalledWith(3, `https://cid.contact/cid/${testCid}`, {
      headers: { Accept: 'application/json' },
    })

    expect(onProgress).toHaveBeenCalledWith({
      type: 'pieceSyncStatus:providerSynced',
      data: { serviceURL: 'https://sp.example.com', providerIndex: 1, providerCount: 1 },
    })
    expect(onProgress).toHaveBeenCalledWith({
      type: 'pieceSyncStatus:complete',
      data: { providerCount: 1 },
    })
    expect(onProgress).toHaveBeenCalledWith({
      type: 'ipniProviderResults:complete',
      data: { result: true, retryCount: 0 },
    })
  })

  it('should poll every expected provider concurrently before confirming', async () => {
    const providerA = createPDPProvider('https://a.example.com')
    const providerB = createPDPProvider('https://b.example.com')
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('a.example.com')) return pieceStatusResponse(true)
      if (url.includes('b.example.com')) return pieceStatusResponse(true)
      return successResponse(['/dns/a.example.com/tcp/443/https', '/dns/b.example.com/tcp/443/https'])
    })
    const onProgress = vi.fn()

    const promise = waitForIndexingConfirmation(testCid, testPieceCid, {
      expectedProviders: [providerA, providerB],
      onProgress,
    })
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result).toBe(true)
    expect(mockFetch).toHaveBeenCalledWith(
      `https://a.example.com/pdp/piece/${encodeURIComponent(testPieceCid.toString())}/status`,
      { headers: { Accept: 'application/json' }, signal: expect.any(AbortSignal) }
    )
    expect(mockFetch).toHaveBeenCalledWith(
      `https://b.example.com/pdp/piece/${encodeURIComponent(testPieceCid.toString())}/status`,
      { headers: { Accept: 'application/json' }, signal: expect.any(AbortSignal) }
    )

    expect(onProgress).toHaveBeenCalledWith({
      type: 'pieceSyncStatus:providerSynced',
      data: { serviceURL: 'https://a.example.com', providerIndex: 1, providerCount: 2 },
    })
    expect(onProgress).toHaveBeenCalledWith({
      type: 'pieceSyncStatus:providerSynced',
      data: { serviceURL: 'https://b.example.com', providerIndex: 2, providerCount: 2 },
    })
    expect(onProgress).toHaveBeenCalledWith({
      type: 'pieceSyncStatus:complete',
      data: { providerCount: 2 },
    })
  })

  it('should reject with a plain error, and never touch the indexer, when a provider never reports synced', async () => {
    const provider = createPDPProvider('https://sp.example.com')
    mockFetch.mockResolvedValue(pieceStatusResponse(false))
    const onProgress = vi.fn()

    const promise = waitForIndexingConfirmation(testCid, testPieceCid, {
      expectedProviders: [provider],
      maxAttempts: 2,
      delayMs: 1,
      onProgress,
    })
    const expectPromise = expect(promise).rejects.not.toBeInstanceOf(IndexerMismatchError)

    await vi.runAllTimersAsync()
    await expectPromise

    expect(onProgress).toHaveBeenCalledWith({
      type: 'pieceSyncStatus:failed',
      data: { error: expect.any(Error), providerCount: 1 },
    })
    // No fallback: a plain piece-status timeout doesn't touch the indexer.
    expect(mockFetch).not.toHaveBeenCalledWith(expect.stringContaining('cid.contact'), expect.anything())
  })

  it('should throw IndexerMismatchError when Curio confirms synced but the indexer still disagrees', async () => {
    const provider = createPDPProvider('https://sp.example.com')
    mockFetch.mockResolvedValueOnce(pieceStatusResponse(true)).mockResolvedValue(emptyProviderResponse())
    const onProgress = vi.fn()

    const promise = waitForIndexingConfirmation(testCid, testPieceCid, {
      expectedProviders: [provider],
      indexerMaxAttempts: 1,
      onProgress,
    })
    const expectPromise = expect(promise).rejects.toBeInstanceOf(IndexerMismatchError)

    await vi.runAllTimersAsync()
    await expectPromise

    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ type: 'indexingConfirmation:mismatch' }))
    // The underlying ipniProviderResults:failed is suppressed to avoid double-reporting.
    expect(onProgress).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'ipniProviderResults:failed' }))
  })

  it('should propagate a plain error, not IndexerMismatchError, when the confirming query itself fails', async () => {
    const provider = createPDPProvider('https://sp.example.com')
    mockFetch.mockResolvedValueOnce(pieceStatusResponse(true)).mockRejectedValue(new Error('network down'))
    const onProgress = vi.fn()

    const promise = waitForIndexingConfirmation(testCid, testPieceCid, {
      expectedProviders: [provider],
      indexerMaxAttempts: 1,
      onProgress,
    })
    const expectPromise = expect(promise).rejects.not.toBeInstanceOf(IndexerMismatchError)

    await vi.runAllTimersAsync()
    await expectPromise

    expect(onProgress).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'indexingConfirmation:mismatch' }))
  })

  it('should name the actual configured indexer in the mismatch message, not a hardcoded cid.contact', async () => {
    const provider = createPDPProvider('https://sp.example.com')
    mockFetch.mockResolvedValueOnce(pieceStatusResponse(true)).mockResolvedValue(emptyProviderResponse())

    const promise = waitForIndexingConfirmation(testCid, testPieceCid, {
      expectedProviders: [provider],
      indexerMaxAttempts: 1,
      ipniIndexerUrl: 'https://custom-indexer.example.com',
    })
    const expectPromise = expect(promise).rejects.toThrow('https://custom-indexer.example.com')

    await vi.runAllTimersAsync()
    await expectPromise
  })

  it('should propagate a plain abort, not IndexerMismatchError, when the caller cancels during the final confirming check', async () => {
    const provider = createPDPProvider('https://sp.example.com')
    const abortController = new AbortController()
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/pdp/piece/')) return pieceStatusResponse(true)
      return { ok: false }
    })
    const onProgress = vi.fn()

    const promise = waitForIndexingConfirmation(testCid, testPieceCid, {
      expectedProviders: [provider],
      indexerMaxAttempts: 5,
      signal: abortController.signal,
      onProgress,
    })

    // Let piece-status confirm and the first indexer check happen
    await vi.advanceTimersByTimeAsync(0)
    abortController.abort()

    const expectPromise = expect(promise).rejects.not.toBeInstanceOf(IndexerMismatchError)
    await vi.runAllTimersAsync()
    await expectPromise
    await expect(promise).rejects.toThrow('This operation was aborted')

    expect(onProgress).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'indexingConfirmation:mismatch' }))
  })

  it('should propagate a plain abort, not report pieceSyncStatus:failed, when the caller cancels during piece-sync polling', async () => {
    const provider = createPDPProvider('https://sp.example.com')
    const abortController = new AbortController()
    mockFetch.mockResolvedValue(pieceStatusResponse(false))
    const onProgress = vi.fn()

    const promise = waitForIndexingConfirmation(testCid, testPieceCid, {
      expectedProviders: [provider],
      maxAttempts: 20,
      delayMs: 1000,
      signal: abortController.signal,
      onProgress,
    })

    await vi.advanceTimersByTimeAsync(0)
    abortController.abort()

    const expectPromise = expect(promise).rejects.toThrow('This operation was aborted')
    await vi.runAllTimersAsync()
    await expectPromise

    expect(onProgress).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'pieceSyncStatus:failed' }))
  })

  it('should reject immediately, without a misleading retry log, when an in-flight piece-status fetch is aborted', async () => {
    const provider = createPDPProvider('https://sp.example.com')
    const abortController = new AbortController()
    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    })

    const promise = waitForIndexingConfirmation(testCid, testPieceCid, {
      expectedProviders: [provider],
      maxAttempts: 20,
      delayMs: 1000,
      signal: abortController.signal,
    })

    await vi.advanceTimersByTimeAsync(0)
    abortController.abort()

    await expect(promise).rejects.toThrow('This operation was aborted')
    // Only the one in-flight call — the abort short-circuits the catch instead of retrying.
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('should fail immediately, without querying the indexer, when there are no expected providers', async () => {
    const promise = waitForIndexingConfirmation(testCid, testPieceCid, {})

    await expect(promise).rejects.toThrow(/requires expectedProviders/)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('should abort a sibling provider poll once another exhausts its attempts', async () => {
    const providerA = createPDPProvider('https://a.example.com')
    const providerB = createPDPProvider('https://b.example.com')
    // B is slow enough that A exhausts and aborts it before B's next signal check.
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('b.example.com')) {
        return new Promise((resolve) => setTimeout(() => resolve(pieceStatusResponse(false)), 100_000))
      }
      return pieceStatusResponse(false)
    })

    const promise = waitForIndexingConfirmation(testCid, testPieceCid, {
      expectedProviders: [providerA, providerB],
      maxAttempts: 3,
      delayMs: 10,
    })
    const expectPromise = expect(promise).rejects.toThrow()

    await vi.runAllTimersAsync()
    await expectPromise

    const bCalls = mockFetch.mock.calls.filter((call: unknown[]) =>
      (call[0] as string).includes('b.example.com')
    ).length
    // Without aborting siblings, B would keep polling up to its own maxAttempts (3).
    expect(bCalls).toBe(1)
  })
})
