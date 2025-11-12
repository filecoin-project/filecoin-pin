import type { ProviderInfo } from '@filoz/synapse-sdk'
import { CID } from 'multiformats/cid'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateIPNIAdvertisement } from '../../core/utils/validate-ipni-advertisement.js'

describe('validateIPNIAdvertisement', () => {
  const testCid = CID.parse('bafkreia5fn4rmshmb7cl7fufkpcw733b5anhuhydtqstnglpkzosqln5kq')
  const defaultIndexerUrl = 'https://filecoinpin.contact'
  const mockFetch = vi.fn()

  const createProviderInfo = (serviceURL: string): ProviderInfo =>
    ({
      id: 1234,
      serviceProvider: 'f01234',
      name: 'Test Provider',
      products: {
        PDP: {
          data: {
            serviceURL,
          },
        },
      },
    }) as ProviderInfo

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

      const promise = validateIPNIAdvertisement(testCid, { onProgress })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledWith(`${defaultIndexerUrl}/cid/${testCid}`, {
        headers: { Accept: 'application/json' },
      })

      // Should emit retryUpdate for attempt 0 and a final complete(true)
      expect(onProgress).toHaveBeenCalledWith({ type: 'ipniAdvertisement.retryUpdate', data: { retryCount: 0 } })
      expect(onProgress).toHaveBeenCalledWith({
        type: 'ipniAdvertisement.complete',
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
      const promise = validateIPNIAdvertisement(testCid, { maxAttempts: 5, onProgress })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(4)

      // Expect retryUpdate with counts 0,1,2,3 and final complete with retryCount 3
      expect(onProgress).toHaveBeenCalledWith({ type: 'ipniAdvertisement.retryUpdate', data: { retryCount: 0 } })
      expect(onProgress).toHaveBeenCalledWith({ type: 'ipniAdvertisement.retryUpdate', data: { retryCount: 1 } })
      expect(onProgress).toHaveBeenCalledWith({ type: 'ipniAdvertisement.retryUpdate', data: { retryCount: 2 } })
      expect(onProgress).toHaveBeenCalledWith({ type: 'ipniAdvertisement.retryUpdate', data: { retryCount: 3 } })
      expect(onProgress).toHaveBeenCalledWith({
        type: 'ipniAdvertisement.complete',
        data: { result: true, retryCount: 3 },
      })
    })

    it('should succeed when the expected provider advertises the derived multiaddr', async () => {
      const provider = createProviderInfo('https://example.com')
      const expectedMultiaddr = '/dns/example.com/tcp/443/https'
      mockFetch.mockResolvedValueOnce(successResponse([expectedMultiaddr]))

      const promise = validateIPNIAdvertisement(testCid, { expectedProviders: [provider] })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(`${defaultIndexerUrl}/cid/${testCid}`, {
        headers: { Accept: 'application/json' },
      })
    })

    it('should succeed when all expected providers are advertised', async () => {
      const providerA = createProviderInfo('https://a.example.com')
      const providerB = createProviderInfo('https://b.example.com:8443')
      const expectedMultiaddrs = ['/dns/a.example.com/tcp/443/https', '/dns/b.example.com/tcp/8443/https']

      mockFetch.mockResolvedValueOnce(successResponse(expectedMultiaddrs))

      const promise = validateIPNIAdvertisement(testCid, { expectedProviders: [providerA, providerB] })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
    })
  })

  describe('failed announcement', () => {
    it('should reject after custom maxAttempts and emit a failed event', async () => {
      mockFetch.mockResolvedValue({ ok: false })
      const onProgress = vi.fn()
      const promise = validateIPNIAdvertisement(testCid, { maxAttempts: 3, onProgress })
      // Attach rejection handler immediately
      const expectPromise = expect(promise).rejects.toThrow(
        `IPFS root CID "${testCid.toString()}" not announced to IPNI after 3 attempts`
      )

      await vi.runAllTimersAsync()
      await expectPromise
      expect(mockFetch).toHaveBeenCalledTimes(3)

      // Expect retryUpdate with counts 0,1,2 and final failed event (no complete event on failure)
      expect(onProgress).toHaveBeenCalledWith({ type: 'ipniAdvertisement.retryUpdate', data: { retryCount: 0 } })
      expect(onProgress).toHaveBeenCalledWith({ type: 'ipniAdvertisement.retryUpdate', data: { retryCount: 1 } })
      expect(onProgress).toHaveBeenCalledWith({ type: 'ipniAdvertisement.retryUpdate', data: { retryCount: 2 } })
      // Should emit failed event, not complete(false)
      expect(onProgress).toHaveBeenCalledWith({
        type: 'ipniAdvertisement.failed',
        data: { error: expect.any(Error) },
      })
      // Should NOT emit complete event
      expect(onProgress).not.toHaveBeenCalledWith({
        type: 'ipniAdvertisement.complete',
        data: { result: false, retryCount: expect.any(Number) },
      })
    })

    it('should reject immediately when maxAttempts is 1', async () => {
      mockFetch.mockResolvedValue({ ok: false })

      const promise = validateIPNIAdvertisement(testCid, { maxAttempts: 1 })
      // Attach rejection handler immediately
      const expectPromise = expect(promise).rejects.toThrow(
        `IPFS root CID "${testCid.toString()}" not announced to IPNI after 1 attempt`
      )

      await vi.runAllTimersAsync()
      await expectPromise
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
    it('should reject when an expected provider is missing from the advertisement', async () => {
      const provider = createProviderInfo('https://expected.example.com')
      mockFetch.mockResolvedValueOnce(successResponse(['/dns/other.example.com/tcp/443/https']))

      const promise = validateIPNIAdvertisement(testCid, {
        maxAttempts: 1,
        expectedProviders: [provider],
      })

      const expectPromise = expect(promise).rejects.toThrow(
        `IPFS root CID "${testCid.toString()}" not announced to IPNI after 1 attempt. Last observation: Missing advertisement for expected multiaddr(s): /dns/expected.example.com/tcp/443/https`
      )
      await vi.runAllTimersAsync()
      await expectPromise
    })

    it('should reject when not all expected providers are advertised', async () => {
      const providerA = createProviderInfo('https://a.example.com')
      const providerB = createProviderInfo('https://b.example.com')
      mockFetch.mockResolvedValueOnce(successResponse(['/dns/a.example.com/tcp/443/https']))

      const promise = validateIPNIAdvertisement(testCid, {
        maxAttempts: 1,
        expectedProviders: [providerA, providerB],
      })

      const expectPromise = expect(promise).rejects.toThrow(
        `IPFS root CID "${testCid.toString()}" not announced to IPNI after 1 attempt. Last observation: Missing advertisement for expected multiaddr(s): /dns/b.example.com/tcp/443/https`
      )
      await vi.runAllTimersAsync()
      await expectPromise
    })

    it('should retry until the expected provider appears in subsequent attempts', async () => {
      const provider = createProviderInfo('https://expected.example.com')
      const expectedMultiaddr = '/dns/expected.example.com/tcp/443/https'
      mockFetch
        .mockResolvedValueOnce(successResponse(['/dns/other.example.com/tcp/443/https']))
        .mockResolvedValueOnce(successResponse([expectedMultiaddr]))

      const promise = validateIPNIAdvertisement(testCid, {
        maxAttempts: 3,
        expectedProviders: [provider],
        delayMs: 1,
      })

      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('should retry when the IPNI response contains no provider results', async () => {
      const provider = createProviderInfo('https://expected.example.com')
      const expectedMultiaddr = '/dns/expected.example.com/tcp/443/https'
      mockFetch
        .mockResolvedValueOnce(emptyProviderResponse())
        .mockResolvedValueOnce(successResponse([expectedMultiaddr]))

      const promise = validateIPNIAdvertisement(testCid, {
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

      const promise = validateIPNIAdvertisement(testCid, { signal: abortController.signal })
      // Attach rejection handler immediately
      const expectPromise = expect(promise).rejects.toThrow('Check IPNI announce aborted')

      await vi.runAllTimersAsync()
      await expectPromise
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('should abort when signal is triggered during retry', async () => {
      const abortController = new AbortController()
      mockFetch.mockResolvedValue({ ok: false })

      const promise = validateIPNIAdvertisement(testCid, { signal: abortController.signal, maxAttempts: 5 })

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

      const promise = validateIPNIAdvertisement(testCid, { signal: abortController.signal })
      await vi.runAllTimersAsync()
      await promise

      expect(mockFetch).toHaveBeenCalledWith(`${defaultIndexerUrl}/cid/${testCid}`, {
        headers: { Accept: 'application/json' },
        signal: abortController.signal,
      })
    })
  })

  describe('edge cases', () => {
    it('should handle fetch throwing an error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      const promise = validateIPNIAdvertisement(testCid, {})
      const expectPromise = expect(promise).rejects.toThrow('Network error')

      await vi.runAllTimersAsync()
      await expectPromise
    })

    it('should handle different CID formats', async () => {
      const v0Cid = CID.parse('QmNT6isqrhH6LZWg8NeXQYTD9wPjJo2BHHzyezpf9BdHbD')
      mockFetch.mockResolvedValueOnce(successResponse())

      const promise = validateIPNIAdvertisement(v0Cid, {})
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

      const promise = validateIPNIAdvertisement(testCid, { maxAttempts: 1 })
      await vi.runAllTimersAsync()
      const result = await promise

      // Should succeed because at least one valid provider exists
      expect(result).toBe(true)
    })

    it('should handle provider without serviceURL by falling back to generic validation', async () => {
      const providerWithoutURL = {
        id: 1234,
        serviceProvider: 'f01234',
        name: 'Test Provider',
        products: { PDP: { data: {} } },
      } as ProviderInfo

      mockFetch.mockResolvedValueOnce(successResponse())

      const promise = validateIPNIAdvertisement(testCid, { expectedProviders: [providerWithoutURL] })
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

      const promise = validateIPNIAdvertisement(testCid, { maxAttempts: 1 })
      // Should preserve the specific "Failed to parse" message, not overwrite with generic message
      const expectPromise = expect(promise).rejects.toThrow('Failed to parse IPNI response body')

      await vi.runAllTimersAsync()
      await expectPromise
    })

    it('should clear stale multiaddrs when parse error occurs after successful response', async () => {
      // Attempt 1: successful response with multiaddrs but doesn't match expectations
      // Attempt 2: parse error - should clear the multiaddrs from attempt 1
      const provider = createProviderInfo('https://expected.example.com')
      mockFetch.mockResolvedValueOnce(successResponse(['/dns/other.example.com/tcp/443/https'])).mockResolvedValueOnce({
        ok: true,
        json: vi.fn(async () => {
          throw new Error('Invalid JSON')
        }),
      })

      const promise = validateIPNIAdvertisement(testCid, {
        maxAttempts: 2,
        expectedProviders: [provider],
      })

      const expectPromise = expect(promise).rejects.toThrow(
        'Failed to parse IPNI response body. Expected multiaddrs: [/dns/expected.example.com/tcp/443/https]. Actual multiaddrs in response: []'
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

      const promise = validateIPNIAdvertisement(testCid, { maxAttempts: 2 })

      const expectPromise = expect(promise).rejects.toThrow(
        'Last observation: IPNI response did not include any provider results'
      )

      await vi.runAllTimersAsync()
      await expectPromise
    })

    it('should use custom IPNI indexer URL when provided', async () => {
      const customIndexerUrl = 'https://custom-indexer.example.com'
      mockFetch.mockResolvedValueOnce(successResponse())

      const promise = validateIPNIAdvertisement(testCid, { ipniIndexerUrl: customIndexerUrl })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(`${customIndexerUrl}/cid/${testCid}`, {
        headers: { Accept: 'application/json' },
      })
    })
  })
})
