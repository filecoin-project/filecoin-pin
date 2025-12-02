/**
 * Unit tests for calculateActualStorage
 *
 * Tests abort handling, timeout behavior, and basic calculation correctness.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { calculateActualStorage } from '../../core/data-set/calculate-actual-storage.js'
import type { DataSetSummary } from '../../core/data-set/types.js'

// Mock the dependencies
const { mockSynapse, mockCreateStorageContext, mockGetDataSetPieces, state } = vi.hoisted(() => {
  const state = {
    pieces: [] as Array<{ pieceId: number; pieceCid: string; size?: number }>,
    shouldAbort: false,
    abortAtIndex: -1,
  }

  const mockGetAddress = vi.fn(async () => '0xtest-address')

  const mockStorageContext = {
    dataSetId: 1,
    getPieces: vi.fn(async function* () {
      for (const piece of state.pieces) {
        if (state.shouldAbort) throw new Error('Aborted')
        yield piece
      }
    }),
  }

  const mockCreateStorageContext = vi.fn(async () => ({
    storage: mockStorageContext,
    providerInfo: { id: 1 },
  }))

  const mockGetDataSetPieces = vi.fn(async (_synapse: any, _context: any, _options?: any) => {
    // Check if aborted
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
      dataSetId: 1,
      totalSizeBytes,
      warnings: [],
    }
  })

  const mockSynapse = {
    getClient: () => ({ getAddress: mockGetAddress }),
    getProvider: () => ({}),
  }

  return {
    mockSynapse,
    mockCreateStorageContext,
    mockGetDataSetPieces,
    state,
  }
})

// Mock the imports
vi.mock('../../core/synapse/storage-context-helper.js', () => ({
  createStorageContextFromDataSetId: mockCreateStorageContext,
}))

vi.mock('../../core/data-set/get-data-set-pieces.js', () => ({
  getDataSetPieces: mockGetDataSetPieces,
}))

describe('calculateActualStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.pieces = []
    state.shouldAbort = false
    state.abortAtIndex = -1
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
        } as DataSetSummary,
        {
          dataSetId: 2,
          providerId: 1,
          serviceProvider: '0xprovider1',
          isLive: true,
        } as DataSetSummary,
      ]

      // Mock pieces for dataset 1: 2 pieces of 1 GiB each
      const oneGiB = 1024n * 1024n * 1024n
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
        } as DataSetSummary,
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
        } as DataSetSummary,
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

    it('should handle abort during processing', async () => {
      const dataSets: DataSetSummary[] = [
        {
          dataSetId: 1,
          providerId: 1,
          serviceProvider: '0xprovider1',
          isLive: true,
        } as DataSetSummary,
        {
          dataSetId: 2,
          providerId: 2,
          serviceProvider: '0xprovider2',
          isLive: true,
        } as DataSetSummary,
      ]

      state.pieces = [{ pieceId: 1, pieceCid: 'bafy1', size: 1024 }]

      const controller = new AbortController()

      // Abort after first dataset processes
      let callCount = 0
      mockGetDataSetPieces.mockImplementation(async (_synapse: any, _context: any, _options?: any) => {
        callCount++
        if (callCount === 2) {
          controller.abort()
          const error = new Error('This operation was aborted')
          error.name = 'AbortError'
          throw error
        }

        return {
          pieces: state.pieces.map((p) => ({
            pieceId: p.pieceId,
            pieceCid: p.pieceCid,
            size: p.size ?? undefined,
          })),
          dataSetId: 1,
          totalSizeBytes: 1024n,
          warnings: [],
        }
      })

      const result = await calculateActualStorage(mockSynapse as any, dataSets, {
        signal: controller.signal,
      })

      expect(result.timedOut).toBe(true)
      expect(result.dataSetsProcessed).toBeGreaterThan(0)
      expect(result.dataSetsProcessed).toBeLessThan(dataSets.length)
    })

    it('should return partial results on abort', async () => {
      const dataSets: DataSetSummary[] = [
        {
          dataSetId: 1,
          providerId: 1,
          serviceProvider: '0xprovider1',
          isLive: true,
        } as DataSetSummary,
        {
          dataSetId: 2,
          providerId: 2,
          serviceProvider: '0xprovider2',
          isLive: true,
        } as DataSetSummary,
      ]

      const controller = new AbortController()

      // Allow first dataset to complete
      let callCount = 0
      mockGetDataSetPieces.mockImplementation(async (_synapse: any, _context: any, _options?: any) => {
        callCount++
        if (callCount === 1) {
          return {
            pieces: [{ pieceId: 1, pieceCid: 'bafy1', size: 1024 }],
            dataSetId: 1,
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
        } as DataSetSummary,
        {
          dataSetId: 2,
          providerId: 2,
          serviceProvider: '0xprovider2',
          isLive: true,
        } as DataSetSummary,
      ]

      let callCount = 0
      mockGetDataSetPieces.mockImplementation(async (_synapse: any, _context: any, _options?: any) => {
        callCount++
        if (callCount === 1) {
          throw new Error('Dataset query failed')
        }

        return {
          pieces: [{ pieceId: 1, pieceCid: 'bafy1', size: 1024 }],
          dataSetId: 2,
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
