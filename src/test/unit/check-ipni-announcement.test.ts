import { CID } from 'multiformats/cid'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkIPNIAnnouncement } from '../../core/utils/check-ipni-announcement.js'

describe('checkIPNIAnnouncement', () => {
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
    it('should resolve true when CID is announced on first attempt', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true })

      const promise = checkIPNIAnnouncement(testCid)
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledWith(`https://filecoinpin.contact/cid/${testCid}`, {})
    })

    it('should retry multiple times before succeeding', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: true })

      const promise = checkIPNIAnnouncement(testCid, { maxAttempts: 5 })
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(4)
    })
  })

  describe('failed announcement', () => {
    it('should reject after custom maxAttempts', async () => {
      mockFetch.mockResolvedValue({ ok: false })

      const promise = checkIPNIAnnouncement(testCid, { maxAttempts: 3 })
      // Attach rejection handler immediately
      const expectPromise = expect(promise).rejects.toThrow(
        `IPFS root CID "${testCid.toString()}" not announced to IPNI after 3 attempts`
      )

      await vi.runAllTimersAsync()
      await expectPromise
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })

    it('should reject immediately when maxAttempts is 1', async () => {
      mockFetch.mockResolvedValue({ ok: false })

      const promise = checkIPNIAnnouncement(testCid, { maxAttempts: 1 })
      // Attach rejection handler immediately
      const expectPromise = expect(promise).rejects.toThrow(
        `IPFS root CID "${testCid.toString()}" not announced to IPNI after 1 attempts`
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

      const promise = checkIPNIAnnouncement(testCid, { signal: abortController.signal })
      // Attach rejection handler immediately
      const expectPromise = expect(promise).rejects.toThrow('Check IPNI announce aborted')

      await vi.runAllTimersAsync()
      await expectPromise
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('should abort when signal is triggered during retry', async () => {
      const abortController = new AbortController()
      mockFetch.mockResolvedValue({ ok: false })

      const promise = checkIPNIAnnouncement(testCid, { signal: abortController.signal, maxAttempts: 5 })

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

      const promise = checkIPNIAnnouncement(testCid, { signal: abortController.signal })
      await vi.runAllTimersAsync()
      await promise

      expect(mockFetch).toHaveBeenCalledWith(`https://filecoinpin.contact/cid/${testCid}`, {
        signal: abortController.signal,
      })
    })

    it('should not include signal in fetch options when not provided', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true })

      const promise = checkIPNIAnnouncement(testCid, { })
      await vi.runAllTimersAsync()
      await promise

      expect(mockFetch).toHaveBeenCalledWith(`https://filecoinpin.contact/cid/${testCid}`, {})
    })
  })

  describe('exponential backoff', () => {
    it('should cap delay at 30000ms (maxDelayMs)', async () => {
      mockFetch.mockResolvedValue({ ok: false })

      const promise = checkIPNIAnnouncement(testCid, { maxAttempts: 10 })
      // Attach rejection handler immediately
      const expectPromise = expect(promise).rejects.toThrow()

      // Skip to where delay would exceed max
      await vi.advanceTimersByTimeAsync(0) // 1st: immediate
      expect(mockFetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1000) // 2nd: 1000ms
      expect(mockFetch).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(2000) // 3rd: 2000ms
      expect(mockFetch).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(4000) // 4th: 4000ms
      expect(mockFetch).toHaveBeenCalledTimes(4)
      await vi.advanceTimersByTimeAsync(8000) // 5th: 8000ms
      expect(mockFetch).toHaveBeenCalledTimes(5)
      await vi.advanceTimersByTimeAsync(16000) // 6th: 16000ms
      expect(mockFetch).toHaveBeenCalledTimes(6)

      // 7th attempt: would be 32000ms but capped at 30000ms
      await vi.advanceTimersByTimeAsync(30000)
      expect(mockFetch).toHaveBeenCalledTimes(7)

      // 8th attempt: also capped at 30000ms
      await vi.advanceTimersByTimeAsync(30000)
      expect(mockFetch).toHaveBeenCalledTimes(8)

      // Complete remaining attempts
      await vi.runAllTimersAsync()
      await expectPromise
    })
  })

  describe('edge cases', () => {
    it('should handle fetch throwing an error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      const promise = checkIPNIAnnouncement(testCid, {})
      // Attach rejection handler immediately
      const expectPromise = expect(promise).rejects.toThrow('Network error')

      await vi.runAllTimersAsync()
      await expectPromise
    })

    it('should handle different CID formats', async () => {
      const v0Cid = CID.parse('QmNT6isqrhH6LZWg8NeXQYTD9wPjJo2BHHzyezpf9BdHbD')
      mockFetch.mockResolvedValueOnce({ ok: true })

      const promise = checkIPNIAnnouncement(v0Cid, {})
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(`https://filecoinpin.contact/cid/${v0Cid}`, {})
    })

    it('should handle maxAttempts of 1', async () => {
      mockFetch.mockResolvedValue({ ok: false })

      const promise = checkIPNIAnnouncement(testCid, { maxAttempts: 1 })
      // Attach rejection handler immediately
      const expectPromise = expect(promise).rejects.toThrow(
        `IPFS root CID "${testCid.toString()}" not announced to IPNI after 1 attempts`
      )

      await vi.runAllTimersAsync()
      await expectPromise
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })
})
