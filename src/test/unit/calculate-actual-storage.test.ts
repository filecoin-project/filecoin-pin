/**
 * Unit tests for calculateActualStorage
 *
 * Tests abort handling, timeout behavior, and basic calculation correctness.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { calculateActualStorage } from '../../core/data-set/calculate-actual-storage.js'
import type { DataSetSummary } from '../../core/data-set/types.js'

// Mock the dependencies
const {
  mockSynapse,
  mockCreateStorageContext,
  mockGetDataSetPieces,
  mockGetProviders,
  defaultCreateStorageContext,
  defaultGetDataSetPieces,
  state,
} = vi.hoisted(() => {
  const state = {
    pieces: [] as Array<{ pieceId: number; pieceCid: string; size?: number }>,
  }

  const defaultGetDataSetPieces = async (_synapse: any, dataSetId: bigint, _serviceURL: string, _options?: any) => {
    if (_options?.signal?.aborted) {
      const error = new Error('This operation was aborted')
      error.name = 'AbortError'
      throw error
    }

    const pieces = state.pieces.map((p) => ({
      pieceId: p.pieceId,
      pieceCid: p.pieceCid,
      size: p.size ?? undefined,
    }))

    const totalSizeBytes = pieces.reduce((sum, p) => sum + BigInt(p.size ?? 0), 0n)

    return {
      pieces,
      dataSetId,
      totalSizeBytes,
      warnings: [],
    }
  }

  const mockGetDataSetPieces = vi.fn(defaultGetDataSetPieces)

  const defaultCreateStorageContext = async ({ dataSetId }: any) => ({
    storage: { dataSetId },
    providerInfo: { id: 1 },
  })

  const mockCreateStorageContext = vi.fn(defaultCreateStorageContext)

  const mockGetProviders = vi.fn(async ({ providerIds }: { providerIds: bigint[] }) =>
    providerIds.map((id) => ({
      id,
      name: `Provider ${id}`,
      pdp: { serviceURL: `https://provider-${id}.example.com` },
    }))
  )

  const mockSynapse = {
    client: {
      account: {
        address: '0xtest-address' as const,
      },
    },
    storage: {
      createContext: mockCreateStorageContext,
    },
    providers: {
      getProviders: mockGetProviders,
    },
  }

  return {
    mockSynapse,
    mockCreateStorageContext,
    mockGetDataSetPieces,
    mockGetProviders,
    defaultCreateStorageContext,
    defaultGetDataSetPieces,
    state,
  }
})

vi.mock('../../core/data-set/get-data-set-pieces.js', () => ({
  getDataSetPieces: mockGetDataSetPieces,
}))

describe('calculateActualStorage', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    state.pieces = []

    mockCreateStorageContext.mockImplementation(defaultCreateStorageContext)
    mockGetDataSetPieces.mockImplementation(defaultGetDataSetPieces)
    mockGetProviders.mockImplementation(async ({ providerIds }) =>
      providerIds.map((id) => ({
        id,
        name: `Provider ${id}`,
        pdp: { serviceURL: `https://provider-${id}.example.com` },
      }))
    )
  })

  describe('basic calculation', () => {
    it('should calculate total storage from multiple data sets', async () => {
      // Setup: 2 data sets with different piece sizes
      const dataSets: DataSetSummary[] = [
        {
          dataSetId: 1,
          providerId: 1,
          serviceProvider: '0xprovider1',
          isLive: true,
        } as unknown as DataSetSummary,
        {
          dataSetId: 2,
          providerId: 1,
          serviceProvider: '0xprovider1',
          isLive: true,
        } as unknown as DataSetSummary,
      ]

      const oneGiB = 1024n * 1024n * 1024n
      // pieces apply to both data sets
      state.pieces = [
        { pieceId: 1, pieceCid: 'bafy1', size: Number(oneGiB) },
        { pieceId: 2, pieceCid: 'bafy2', size: Number(oneGiB) },
      ]

      const result = await calculateActualStorage(mockSynapse as any, dataSets)

      expect(result.dataSetCount).toBe(2)
      expect(result.dataSetsProcessed).toBe(2)
      expect(result.totalBytes).toBe(oneGiB * 2n * 2n) // 2 pieces × 2 datasets
      expect(result.pieceCount).toBe(4)
      expect(result.timedOut).toBeFalsy()
      expect(result.warnings).toHaveLength(0)
    })

    it('should handle empty data sets', async () => {
      const result = await calculateActualStorage(mockSynapse as any, [])

      expect(result.dataSetCount).toBe(0)
      expect(result.dataSetsProcessed).toBe(0)
      expect(result.totalBytes).toBe(0n)
      expect(result.pieceCount).toBe(0)
      expect(result.timedOut).toBeFalsy()
    })

    it('should handle data sets with no pieces', async () => {
      const dataSets: DataSetSummary[] = [
        {
          dataSetId: 1,
          providerId: 1,
          serviceProvider: '0xprovider1',
          isLive: true,
        } as unknown as DataSetSummary,
      ]

      state.pieces = []

      const result = await calculateActualStorage(mockSynapse as any, dataSets)

      expect(result.dataSetCount).toBe(1)
      expect(result.dataSetsProcessed).toBe(1)
      expect(result.totalBytes).toBe(0n)
      expect(result.pieceCount).toBe(0)
    })
  })

  describe('abort handling', () => {
    it('should handle immediate abort', async () => {
      const dataSets: DataSetSummary[] = [
        {
          dataSetId: 1,
          providerId: 1,
          serviceProvider: '0xprovider1',
          isLive: true,
        } as unknown as DataSetSummary,
      ]

      // Create already-aborted signal
      const controller = new AbortController()
      controller.abort()

      const result = await calculateActualStorage(mockSynapse as any, dataSets, {
        signal: controller.signal,
      })

      expect(result.timedOut).toBe(true)
      expect(result.dataSetsProcessed).toBe(0)
      expect(result.warnings.some((w) => w.code === 'CALCULATION_ABORTED')).toBe(true)
    })

    it('should return partial results on abort', async () => {
      const dataSets: DataSetSummary[] = [
        {
          dataSetId: 1,
          providerId: 1,
          serviceProvider: '0xprovider1',
          isLive: true,
        } as unknown as DataSetSummary,
        {
          dataSetId: 2,
          providerId: 2,
          serviceProvider: '0xprovider2',
          isLive: true,
        } as unknown as DataSetSummary,
      ]

      const controller = new AbortController()

      // Allow first dataset to complete
      let callCount = 0
      mockGetDataSetPieces.mockImplementation(async (_synapse: any, dataSetId: bigint) => {
        callCount++
        if (callCount === 1) {
          return {
            pieces: [{ pieceId: 1, pieceCid: 'bafy1', size: 1024 }],
            dataSetId,
            totalSizeBytes: 1024n,
            warnings: [],
          }
        }

        controller.abort()
        const error = new Error('This operation was aborted')
        error.name = 'AbortError'
        throw error
      })

      const result = await calculateActualStorage(mockSynapse as any, dataSets, {
        signal: controller.signal,
      })

      expect(result.timedOut).toBe(true)
      expect(result.totalBytes).toBe(1024n) // Partial result from first dataset
      expect(result.dataSetsProcessed).toBe(1)
      expect(result.pieceCount).toBe(1)
      expect(result.warnings.some((w) => w.code === 'CALCULATION_ABORTED')).toBe(true)
    })
  })

  describe('provider enrichment', () => {
    it('fetches missing providers in a single multicall', async () => {
      const dataSets: DataSetSummary[] = [
        { dataSetId: 1n, providerId: 1n, isLive: true } as unknown as DataSetSummary,
        { dataSetId: 2n, providerId: 1n, isLive: true } as unknown as DataSetSummary,
        { dataSetId: 3n, providerId: 2n, isLive: true } as unknown as DataSetSummary,
      ]

      await calculateActualStorage(mockSynapse as any, dataSets)

      expect(mockGetProviders).toHaveBeenCalledTimes(1)
      expect(mockGetProviders).toHaveBeenCalledWith({ providerIds: [1n, 2n] })
      // Each dataset should have received the matching serviceURL
      const serviceURLs = mockGetDataSetPieces.mock.calls.map((call) => call[2])
      expect(serviceURLs).toContain('https://provider-1.example.com')
      expect(serviceURLs).toContain('https://provider-2.example.com')
    })

    it('skips fetching when every dataset already carries provider info', async () => {
      const dataSets: DataSetSummary[] = [
        {
          dataSetId: 1n,
          providerId: 1n,
          isLive: true,
          provider: { id: 1n, name: 'Pre-filled', pdp: { serviceURL: 'https://pre-filled.example.com' } },
        } as unknown as DataSetSummary,
      ]

      await calculateActualStorage(mockSynapse as any, dataSets)

      expect(mockGetProviders).not.toHaveBeenCalled()
      expect(mockGetDataSetPieces.mock.calls[0]?.[2]).toBe('https://pre-filled.example.com')
    })

    it('continues with empty serviceURL when provider enrichment fails', async () => {
      mockGetProviders.mockRejectedValueOnce(new Error('Network error'))
      const dataSets: DataSetSummary[] = [{ dataSetId: 1n, providerId: 1n, isLive: true } as unknown as DataSetSummary]

      const result = await calculateActualStorage(mockSynapse as any, dataSets)

      expect(result.dataSetsProcessed).toBe(1)
      expect(mockGetDataSetPieces.mock.calls[0]?.[2]).toBe('')
    })
  })

  describe('error handling', () => {
    it('should continue processing other datasets when one fails', async () => {
      const dataSets: DataSetSummary[] = [
        {
          dataSetId: 1,
          providerId: 1,
          serviceProvider: '0xprovider1',
          isLive: true,
        } as unknown as DataSetSummary,
        {
          dataSetId: 2,
          providerId: 2,
          serviceProvider: '0xprovider2',
          isLive: true,
        } as unknown as DataSetSummary,
      ]

      let callCount = 0
      mockGetDataSetPieces.mockImplementation(async (_synapse: any, dataSetId: bigint) => {
        callCount++
        if (callCount === 1) {
          throw new Error('Dataset query failed')
        }

        return {
          pieces: [{ pieceId: 1, pieceCid: 'bafy1', size: 1024 }],
          dataSetId,
          totalSizeBytes: 1024n,
          warnings: [],
        }
      })

      const result = await calculateActualStorage(mockSynapse as any, dataSets)

      expect(result.dataSetsProcessed).toBe(1) // Only second dataset succeeded
      expect(result.totalBytes).toBe(1024n)
      expect(result.warnings.some((w) => w.code === 'DATA_SET_QUERY_FAILED')).toBe(true)
    })
  })
})
