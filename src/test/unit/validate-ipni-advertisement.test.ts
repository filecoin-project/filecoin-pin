import { CID } from 'multiformats/cid'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateIPNIAdvertisement } from '../../core/utils/validate-ipni-advertisement.js'

describe('validateIPNIAdvertisement', () => {
  const testCid = CID.parse('bafkreia5fn4rmshmb7cl7fufkpcw733b5anhuhydtqstnglpkzosqln5kq')
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
      mockFetch.mockResolvedValueOnce({ ok: true })
      const onProgress = vi.fn()

      const promise = validateIPNIAdvertisement(testCid, { onProgress })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledWith(`https://filecoinpin.contact/cid/${testCid}`, {})

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
        .mockResolvedValueOnce({ ok: true })

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
  })

  describe('failed announcement', () => {
    it('should reject after custom maxAttempts and emit a final complete(false)', async () => {
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

      // Expect retryUpdate with counts 0,1,2 and final complete(false) with retryCount 3
      expect(onProgress).toHaveBeenCalledWith({ type: 'ipniAdvertisement.retryUpdate', data: { retryCount: 0 } })
      expect(onProgress).toHaveBeenCalledWith({ type: 'ipniAdvertisement.retryUpdate', data: { retryCount: 1 } })
      expect(onProgress).toHaveBeenCalledWith({ type: 'ipniAdvertisement.retryUpdate', data: { retryCount: 2 } })
      expect(onProgress).toHaveBeenCalledWith({
        type: 'ipniAdvertisement.complete',
        data: { result: false, retryCount: 3 },
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
      mockFetch.mockResolvedValueOnce({ ok: true })

      const promise = validateIPNIAdvertisement(testCid, { signal: abortController.signal })
      await vi.runAllTimersAsync()
      await promise

      expect(mockFetch).toHaveBeenCalledWith(`https://filecoinpin.contact/cid/${testCid}`, {
        signal: abortController.signal,
      })
    })
  })

  describe('edge cases', () => {
    it('should handle fetch throwing an error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      const promise = validateIPNIAdvertisement(testCid, {})
      // Attach rejection handler immediately
      const expectPromise = expect(promise).rejects.toThrow('Network error')

      await vi.runAllTimersAsync()
      await expectPromise
    })

    it('should handle different CID formats', async () => {
      const v0Cid = CID.parse('QmNT6isqrhH6LZWg8NeXQYTD9wPjJo2BHHzyezpf9BdHbD')
      mockFetch.mockResolvedValueOnce({ ok: true })

      const promise = validateIPNIAdvertisement(v0Cid, {})
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(`https://filecoinpin.contact/cid/${v0Cid}`, {})
    })

    it('should handle maxAttempts of 1', async () => {
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
  })
})
