import type { PDPProvider } from '@filoz/synapse-sdk'
import { CID } from 'multiformats/cid'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type IpniValidationOutcome,
  waitForIpniProviderResults,
  waitForIpniProviderResultsDetailed,
} from '../../core/utils/validate-ipni-advertisement.js'

describe('waitForIpniProviderResults', () => {
  const testCid = CID.parse('bafkreia5fn4rmshmb7cl7fufkpcw733b5anhuhydtqstnglpkzosqln5kq')
  const defaultIndexerUrl = 'https://filecoinpin.contact'
  const mockFetch = vi.fn()

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

      const promise = waitForIpniProviderResults(testCid, { onProgress })
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
          type: 'ipniProviderResults.retryUpdate',
          data: expect.objectContaining({ retryCount: 0 }),
        })
      )
      expect(onProgress).toHaveBeenCalledWith({
        type: 'ipniProviderResults.complete',
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
      const promise = waitForIpniProviderResults(testCid, { maxAttempts: 5, onProgress })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(4)

      // Expect retryUpdate with counts 0,1,2,3 and final complete after all checks
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ipniProviderResults.retryUpdate',
          data: expect.objectContaining({ retryCount: 0 }),
        })
      )
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ipniProviderResults.retryUpdate',
          data: expect.objectContaining({ retryCount: 1 }),
        })
      )
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ipniProviderResults.retryUpdate',
          data: expect.objectContaining({ retryCount: 2 }),
        })
      )
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ipniProviderResults.retryUpdate',
          data: expect.objectContaining({ retryCount: 3 }),
        })
      )
      expect(onProgress).toHaveBeenCalledWith({
        type: 'ipniProviderResults.complete',
        data: { result: true, retryCount: 3 },
      })
    })

    it('should succeed when the expected provider advertises the derived multiaddr', async () => {
      const provider = createPDPProvider('https://example.com')
      const expectedMultiaddr = '/dns/example.com/tcp/443/https'
      mockFetch.mockResolvedValueOnce(successResponse([expectedMultiaddr]))

      const promise = waitForIpniProviderResults(testCid, { expectedProviders: [provider] })
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

      const promise = waitForIpniProviderResults(testCid, { expectedProviders: [provider] })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
    })

    it('should succeed when IPNI returns short-form http multiaddr', async () => {
      const provider = createPDPProvider('http://example.com')
      mockFetch.mockResolvedValueOnce(successResponse(['/dns/example.com/http']))

      const promise = waitForIpniProviderResults(testCid, { expectedProviders: [provider] })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
    })

    it('should succeed when multiaddr includes http-path and matches service URL path', async () => {
      const provider = createPDPProvider('https://example.com/api/v1')
      mockFetch.mockResolvedValueOnce(successResponse(['/dns/example.com/tcp/443/https/http-path/api%2Fv1']))

      const promise = waitForIpniProviderResults(testCid, { expectedProviders: [provider] })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
    })

    it('should succeed when short-form multiaddr includes http-path', async () => {
      const provider = createPDPProvider('https://example.com/api/v1')
      mockFetch.mockResolvedValueOnce(successResponse(['/dns/example.com/https/http-path/api%2Fv1']))

      const promise = waitForIpniProviderResults(testCid, { expectedProviders: [provider] })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
    })

    it('should match when service URL has trailing slash (normalized away for comparison)', async () => {
      const provider = createPDPProvider('https://example.com/api/v1/')
      // multiaddrToUri strips trailing slashes, so both sides normalize to https://example.com/api/v1
      mockFetch.mockResolvedValueOnce(successResponse(['/dns/example.com/https/http-path/api%2Fv1']))

      const promise = waitForIpniProviderResults(testCid, { expectedProviders: [provider] })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
    })

    it('should succeed when all expected providers are in the IPNI ProviderResults', async () => {
      const providerA = createPDPProvider('https://a.example.com')
      const providerB = createPDPProvider('https://b.example.com:8443')
      const expectedMultiaddrs = ['/dns/a.example.com/tcp/443/https', '/dns/b.example.com/tcp/8443/https']

      mockFetch.mockResolvedValueOnce(successResponse(expectedMultiaddrs))

      const promise = waitForIpniProviderResults(testCid, { expectedProviders: [providerA, providerB] })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
    })

    it('should validate child blocks and emit complete only after all pass', async () => {
      const childCid = CID.parse('bafkreia7wx2ue2r5x2bwsxns2r4jtrsu7dzw2r3abjtw3obqckm3w2b2mu')
      mockFetch.mockResolvedValueOnce(successResponse()).mockResolvedValueOnce(successResponse())
      const onProgress = vi.fn()

      const promise = waitForIpniProviderResults(testCid, { childBlocks: [childCid], onProgress })
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
          type: 'ipniProviderResults.retryUpdate',
          data: expect.objectContaining({ retryCount: 0 }),
        })
      )
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ipniProviderResults.retryUpdate',
          data: expect.objectContaining({ retryCount: 1 }),
        })
      )
      const completeEvents = onProgress.mock.calls.filter(([event]) => event.type === 'ipniProviderResults.complete')
      expect(completeEvents).toHaveLength(1)
      expect(completeEvents[0]?.[0]).toEqual({
        type: 'ipniProviderResults.complete',
        data: { result: true, retryCount: 1 },
      })
    })
  })

  describe('failed announcement', () => {
    it('should fail when a child block does not validate after root succeeds', async () => {
      const childCid = CID.parse('bafkreia7wx2ue2r5x2bwsxns2r4jtrsu7dzw2r3abjtw3obqckm3w2b2mu')
      mockFetch.mockResolvedValueOnce(successResponse()).mockResolvedValueOnce({ ok: false })
      const onProgress = vi.fn()

      const promise = waitForIpniProviderResults(testCid, { childBlocks: [childCid], maxAttempts: 1, onProgress })
      const expectPromise = expect(promise).rejects.toThrow(
        `IPFS CID "${childCid.toString()}" does not have expected IPNI ProviderResults after 1 attempt`
      )

      await vi.runAllTimersAsync()
      await expectPromise

      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ipniProviderResults.retryUpdate',
          data: expect.objectContaining({ retryCount: 0 }),
        })
      )
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ipniProviderResults.retryUpdate',
          data: expect.objectContaining({ retryCount: 1 }),
        })
      )
      expect(onProgress).toHaveBeenCalledWith({
        type: 'ipniProviderResults.failed',
        data: { error: expect.any(Error) },
      })
      expect(onProgress).not.toHaveBeenCalledWith({
        type: 'ipniProviderResults.complete',
        data: { result: true, retryCount: expect.any(Number) },
      })
    })

    it('should reject after custom maxAttempts and emit a failed event', async () => {
      mockFetch.mockResolvedValue({ ok: false })
      const onProgress = vi.fn()
      const promise = waitForIpniProviderResults(testCid, { maxAttempts: 3, onProgress })
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
          type: 'ipniProviderResults.retryUpdate',
          data: expect.objectContaining({ retryCount: 0 }),
        })
      )
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ipniProviderResults.retryUpdate',
          data: expect.objectContaining({ retryCount: 1 }),
        })
      )
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ipniProviderResults.retryUpdate',
          data: expect.objectContaining({ retryCount: 2 }),
        })
      )
      // Should emit failed event, not complete(false)
      expect(onProgress).toHaveBeenCalledWith({
        type: 'ipniProviderResults.failed',
        data: { error: expect.any(Error) },
      })
      // Should NOT emit complete event
      expect(onProgress).not.toHaveBeenCalledWith({
        type: 'ipniProviderResults.complete',
        data: { result: false, retryCount: expect.any(Number) },
      })
    })

    it('should reject immediately when maxAttempts is 1', async () => {
      mockFetch.mockResolvedValue({ ok: false })

      const promise = waitForIpniProviderResults(testCid, { maxAttempts: 1 })
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

      const promise = waitForIpniProviderResults(testCid, {
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

      const promise = waitForIpniProviderResults(testCid, {
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

      const promise = waitForIpniProviderResults(testCid, {
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

      const promise = waitForIpniProviderResults(testCid, {
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

      const promise = waitForIpniProviderResults(testCid, { signal: abortController.signal })
      // Attach rejection handler immediately
      const expectPromise = expect(promise).rejects.toThrow('Check IPNI announce aborted')

      await vi.runAllTimersAsync()
      await expectPromise
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('should abort when signal is triggered during retry', async () => {
      const abortController = new AbortController()
      mockFetch.mockResolvedValue({ ok: false })

      const promise = waitForIpniProviderResults(testCid, { signal: abortController.signal, maxAttempts: 5 })

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

      const promise = waitForIpniProviderResults(testCid, { signal: abortController.signal })
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

      const promise = waitForIpniProviderResults(testCid, { maxAttempts: 2, delayMs: 1 })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('should handle different CID formats', async () => {
      const v0Cid = CID.parse('QmNT6isqrhH6LZWg8NeXQYTD9wPjJo2BHHzyezpf9BdHbD')
      mockFetch.mockResolvedValueOnce(successResponse())

      const promise = waitForIpniProviderResults(v0Cid, {})
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

      const promise = waitForIpniProviderResults(testCid, { maxAttempts: 1 })
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

      const promise = waitForIpniProviderResults(testCid, { expectedProviders: [providerWithoutURL] })
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

      const promise = waitForIpniProviderResults(testCid, { maxAttempts: 1 })
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

      const promise = waitForIpniProviderResults(testCid, {
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

      const promise = waitForIpniProviderResults(testCid, { maxAttempts: 2 })

      const expectPromise = expect(promise).rejects.toThrow(
        'Last observation: IPNI response did not include any provider results'
      )

      await vi.runAllTimersAsync()
      await expectPromise
    })

    it('should expose per-CID outcome via Error.cause on failure (issue #417)', async () => {
      const childCid = CID.parse('bafkreia7wx2ue2r5x2bwsxns2r4jtrsu7dzw2r3abjtw3obqckm3w2b2mu')
      // root verifies, child fails with http
      mockFetch
        .mockResolvedValueOnce(successResponse())
        .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' })

      const promise = waitForIpniProviderResults(testCid, { childBlocks: [childCid], maxAttempts: 1 })
      let caught: Error | undefined
      promise.catch((e) => {
        caught = e
      })
      await vi.runAllTimersAsync()
      await promise.catch(() => undefined)

      expect(caught).toBeInstanceOf(Error)
      const outcome = caught?.cause as IpniValidationOutcome
      expect(outcome.success).toBe(false)
      expect(outcome.verified).toHaveLength(1)
      expect(outcome.verified[0]?.cid.toString()).toBe(testCid.toString())
      expect(outcome.failed).toHaveLength(1)
      expect(outcome.failed[0]?.cid.toString()).toBe(childCid.toString())
      expect(outcome.failed[0]?.reason.type).toBe('http')
    })

    describe('detailed outcome (issue #417)', () => {
      it('returns success outcome for single-CID success', async () => {
        mockFetch.mockResolvedValueOnce(successResponse())
        const promise = waitForIpniProviderResultsDetailed(testCid)
        await vi.runAllTimersAsync()
        const outcome = await promise

        expect(outcome.success).toBe(true)
        expect(outcome.verified).toEqual([{ cid: testCid, attempts: 1 }])
        expect(outcome.failed).toEqual([])
        expect(outcome.ipniIndexerUrl).toBe(defaultIndexerUrl)
      })

      it('returns partial verification: some CIDs verified before a failed one', async () => {
        const childCid1 = CID.parse('bafkreia7wx2ue2r5x2bwsxns2r4jtrsu7dzw2r3abjtw3obqckm3w2b2mu')
        const childCid2 = CID.parse('bafkreidm5pjnb6q4mwkj7s7g6kfjs5hr2ql6grnq2qg5fbq5cppxnpzqle')
        mockFetch
          .mockResolvedValueOnce(successResponse()) // root ✓
          .mockResolvedValueOnce(emptyProviderResponse()) // child1 ✗

        const promise = waitForIpniProviderResultsDetailed(testCid, {
          childBlocks: [childCid1, childCid2],
          maxAttempts: 1,
        })
        await vi.runAllTimersAsync()
        const outcome = await promise

        expect(outcome.success).toBe(false)
        expect(outcome.verified.map((v) => v.cid.toString())).toEqual([testCid.toString()])
        expect(outcome.failed.map((f) => f.cid.toString())).toEqual([childCid1.toString(), childCid2.toString()])
        expect(outcome.failed[0]?.reason.type).toBe('missingProviders')
        expect(outcome.failed[1]?.reason.type).toBe('notAttempted')
      })

      it('returns all-CIDs-missing outcome', async () => {
        const childCid = CID.parse('bafkreia7wx2ue2r5x2bwsxns2r4jtrsu7dzw2r3abjtw3obqckm3w2b2mu')
        mockFetch.mockResolvedValue(emptyProviderResponse())

        const promise = waitForIpniProviderResultsDetailed(testCid, {
          childBlocks: [childCid],
          maxAttempts: 1,
        })
        await vi.runAllTimersAsync()
        const outcome = await promise

        expect(outcome.success).toBe(false)
        expect(outcome.verified).toEqual([])
        expect(outcome.failed).toHaveLength(2)
        expect(outcome.failed[0]?.reason.type).toBe('missingProviders')
        expect(outcome.failed[1]?.reason.type).toBe('notAttempted')
      })

      it('marks aborted-mid-walk CID with reason.type === aborted (signal-aware sleep)', async () => {
        const childCid = CID.parse('bafkreia7wx2ue2r5x2bwsxns2r4jtrsu7dzw2r3abjtw3obqckm3w2b2mu')
        const abortController = new AbortController()
        // root succeeds, child returns ok:false then we abort during the inter-attempt sleep
        mockFetch.mockResolvedValueOnce(successResponse()).mockResolvedValue({ ok: false })

        const promise = waitForIpniProviderResultsDetailed(testCid, {
          childBlocks: [childCid],
          maxAttempts: 5,
          delayMs: 10_000,
          signal: abortController.signal,
        })

        // let root + first child fetch complete
        await vi.advanceTimersByTimeAsync(0)
        // child is now sleeping before its retry; abort interrupts the sleep
        abortController.abort()
        await vi.runAllTimersAsync()
        const outcome = await promise

        expect(outcome.success).toBe(false)
        expect(outcome.verified.map((v) => v.cid.toString())).toEqual([testCid.toString()])
        const childFail = outcome.failed.find((f) => f.cid.toString() === childCid.toString())
        expect(childFail?.reason.type).toBe('aborted')
      })

      it('aborts during inter-attempt sleep without waiting for delayMs (signal-aware)', async () => {
        const abortController = new AbortController()
        mockFetch.mockResolvedValue({ ok: false })

        const promise = waitForIpniProviderResultsDetailed(testCid, {
          maxAttempts: 5,
          delayMs: 60_000,
          signal: abortController.signal,
        })

        // first attempt completes immediately
        await vi.advanceTimersByTimeAsync(0)
        expect(mockFetch).toHaveBeenCalledTimes(1)

        // we should now be inside the 60s inter-attempt sleep — abort and verify
        // we resolve without advancing to delayMs
        abortController.abort()
        const outcome = await promise

        expect(outcome.success).toBe(false)
        expect(outcome.failed[0]?.reason.type).toBe('aborted')
        // crucially: only one fetch — sleep was interrupted before retry
        expect(mockFetch).toHaveBeenCalledTimes(1)
      })

      it('emits ipniProviderResults.outcome event with full per-CID detail', async () => {
        mockFetch.mockResolvedValueOnce(successResponse())
        const onProgress = vi.fn()
        const promise = waitForIpniProviderResults(testCid, { onProgress })
        await vi.runAllTimersAsync()
        await promise

        const outcomeEvents = onProgress.mock.calls.filter(([e]) => e.type === 'ipniProviderResults.outcome')
        expect(outcomeEvents).toHaveLength(1)
        const outcome = outcomeEvents[0]?.[0].data.outcome as IpniValidationOutcome
        expect(outcome.success).toBe(true)
        expect(outcome.verified).toHaveLength(1)
      })
    })

    it('should use custom IPNI indexer URL when provided', async () => {
      const customIndexerUrl = 'https://custom-indexer.example.com'
      mockFetch.mockResolvedValueOnce(successResponse())

      const promise = waitForIpniProviderResults(testCid, { ipniIndexerUrl: customIndexerUrl })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(`${customIndexerUrl}/cid/${testCid}`, {
        headers: { Accept: 'application/json' },
      })
    })
  })
})
