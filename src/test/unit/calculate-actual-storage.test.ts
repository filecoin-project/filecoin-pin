/**
 * Unit tests for calculateActualStorage
 *
 * Tests abort handling, timeout behavior, and basic calculation correctness.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { calculateActualStorage } from '../../core/data-set/calculate-actual-storage.js'
import type { DataSetSummary } from '../../core/data-set/types.js'

vi.mock('../../core/synapse/index.js', () => ({
  getClientAddress: (synapse: { client: { account: string | { address: string } } }) =>
    typeof synapse.client.account === 'string' ? synapse.client.account : synapse.client.account.address,
}))

// Mock the dependencies
const {
  mockSynapse,
  mockCreateStorageContext,
  mockGetSizeFromPieceCID,
  defaultCreateStorageContext,
  defaultGetSizeFromPieceCID,
  state,
} = vi.hoisted(() => {
  const state = {
    piecesByDataSet: new Map<bigint, Array<{ pieceId: bigint; pieceCid: string }>>(),
    scheduledRemovalsByDataSet: new Map<bigint, bigint[]>(),
    sizesByPieceCid: new Map<string, number>(),
  }

  const defaultGetSizeFromPieceCID = (pieceCid: { toString: () => string } | string) => {
    const cid = pieceCid.toString()
    const size = state.sizesByPieceCid.get(cid)
    if (size == null) {
      throw new Error(`Unknown PieceCID: ${cid}`)
    }
    return size
  }

  const mockGetSizeFromPieceCID = vi.fn(defaultGetSizeFromPieceCID)

  const defaultCreateStorageContext = async ({ dataSetId }: { dataSetId: bigint }) => {
    const pieces = state.piecesByDataSet.get(dataSetId) ?? []
    return {
      dataSetId,
      async getScheduledRemovals() {
        return state.scheduledRemovalsByDataSet.get(dataSetId) ?? []
      },
      async *getPieces() {
        for (const piece of pieces) {
          yield {
            pieceId: piece.pieceId,
            pieceCid: {
              toString: () => piece.pieceCid,
            },
          }
        }
      },
    }
  }

  const mockCreateStorageContext = vi.fn(defaultCreateStorageContext)

  const mockSynapse = {
    client: {
      account: {
        address: '0xtest-address' as const,
      },
    },
    storage: {
      createContext: mockCreateStorageContext,
    },
  }

  return {
    mockSynapse,
    mockCreateStorageContext,
    mockGetSizeFromPieceCID,
    defaultCreateStorageContext,
    defaultGetSizeFromPieceCID,
    state,
  }
})

vi.mock('@filoz/synapse-core/piece', () => ({
  getSizeFromPieceCID: mockGetSizeFromPieceCID,
}))

vi.mock('@filoz/synapse-sdk', async () => {
  const sharedMock = await import('../mocks/synapse-sdk.js')
  return sharedMock
})

describe('calculateActualStorage', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    state.piecesByDataSet = new Map()
    state.scheduledRemovalsByDataSet = new Map()
    state.sizesByPieceCid = new Map()
    mockCreateStorageContext.mockImplementation(defaultCreateStorageContext)
    mockGetSizeFromPieceCID.mockImplementation(defaultGetSizeFromPieceCID)
  })

  describe('basic calculation', () => {
    it('should calculate total storage from multiple data sets', async () => {
      const dataSets: DataSetSummary[] = [
        {
          dataSetId: 1n,
          providerId: 1,
          serviceProvider: '0xprovider1',
          isLive: true,
          currentPieceCount: 2,
        } as unknown as DataSetSummary,
        {
          dataSetId: 2n,
          providerId: 1,
          serviceProvider: '0xprovider1',
          isLive: true,
          currentPieceCount: 3,
        } as unknown as DataSetSummary,
      ]

      const oneGiB = 1024 * 1024 * 1024
      state.piecesByDataSet.set(1n, [
        { pieceId: 1n, pieceCid: 'piece-1a' },
        { pieceId: 2n, pieceCid: 'piece-1b' },
      ])
      state.piecesByDataSet.set(2n, [
        { pieceId: 3n, pieceCid: 'piece-2a' },
        { pieceId: 4n, pieceCid: 'piece-2b' },
        { pieceId: 5n, pieceCid: 'piece-2c' },
      ])
      state.sizesByPieceCid = new Map([
        ['piece-1a', oneGiB],
        ['piece-1b', oneGiB],
        ['piece-2a', oneGiB],
        ['piece-2b', oneGiB],
        ['piece-2c', oneGiB],
      ])

      const result = await calculateActualStorage(mockSynapse as any, dataSets)

      expect(result.dataSetCount).toBe(2)
      expect(result.dataSetsProcessed).toBe(2)
      expect(result.totalBytes).toBe(BigInt(oneGiB) * 5n)
      expect(result.pieceCount).toBe(5)
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
          dataSetId: 1n,
          providerId: 1,
          serviceProvider: '0xprovider1',
          isLive: true,
          currentPieceCount: 0,
        } as unknown as DataSetSummary,
      ]

      const result = await calculateActualStorage(mockSynapse as any, dataSets)

      expect(result.dataSetCount).toBe(1)
      expect(result.dataSetsProcessed).toBe(1)
      expect(result.totalBytes).toBe(0n)
      expect(result.pieceCount).toBe(0)
    })

    it('should warn and continue when a piece size cannot be decoded', async () => {
      const dataSets: DataSetSummary[] = [
        {
          dataSetId: 1n,
          providerId: 1,
          serviceProvider: '0xprovider1',
          isLive: true,
          currentPieceCount: 2,
        } as unknown as DataSetSummary,
      ]

      state.piecesByDataSet.set(1n, [
        { pieceId: 1n, pieceCid: 'known-piece' },
        { pieceId: 2n, pieceCid: 'bad-piece' },
      ])
      state.sizesByPieceCid.set('known-piece', 1024)

      const result = await calculateActualStorage(mockSynapse as any, dataSets)

      expect(result.dataSetsProcessed).toBe(1)
      expect(result.totalBytes).toBe(1024n)
      expect(result.pieceCount).toBe(2)
      expect(result.warnings.some((w) => w.code === 'PIECE_SIZE_DECODE_FAILED')).toBe(true)
    })

    it('should exclude pieces scheduled for removal from actual storage', async () => {
      const dataSets: DataSetSummary[] = [
        {
          dataSetId: 1n,
          providerId: 1,
          serviceProvider: '0xprovider1',
          isLive: true,
          currentPieceCount: 3,
        } as unknown as DataSetSummary,
      ]

      state.piecesByDataSet.set(1n, [
        { pieceId: 1n, pieceCid: 'active-piece-a' },
        { pieceId: 2n, pieceCid: 'pending-removal-piece' },
        { pieceId: 3n, pieceCid: 'active-piece-b' },
      ])
      state.scheduledRemovalsByDataSet.set(1n, [2n])
      state.sizesByPieceCid = new Map([
        ['active-piece-a', 512],
        ['pending-removal-piece', 2048],
        ['active-piece-b', 1024],
      ])

      const result = await calculateActualStorage(mockSynapse as any, dataSets)
      const decodedPieceCids = mockGetSizeFromPieceCID.mock.calls.map(([pieceCid]) => pieceCid.toString())

      expect(result.totalBytes).toBe(1536n)
      expect(result.pieceCount).toBe(2)
      expect(decodedPieceCids).toEqual(['active-piece-a', 'active-piece-b'])
      expect(result.warnings).toHaveLength(0)
    })
  })

  describe('abort handling', () => {
    it('should handle immediate abort', async () => {
      const dataSets: DataSetSummary[] = [
        {
          dataSetId: 1n,
          providerId: 1,
          serviceProvider: '0xprovider1',
          isLive: true,
          currentPieceCount: 1,
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
          dataSetId: 1n,
          providerId: 1,
          serviceProvider: '0xprovider1',
          isLive: true,
          currentPieceCount: 1,
        } as unknown as DataSetSummary,
        {
          dataSetId: 2n,
          providerId: 2,
          serviceProvider: '0xprovider2',
          isLive: true,
          currentPieceCount: 2,
        } as unknown as DataSetSummary,
      ]

      const controller = new AbortController()

      let callCount = 0
      mockCreateStorageContext.mockImplementation(async ({ dataSetId }: { dataSetId: bigint }) => {
        callCount++
        if (callCount === 1) {
          return {
            dataSetId,
            async getScheduledRemovals() {
              return []
            },
            async *getPieces() {
              yield { pieceId: 1n, pieceCid: { toString: () => 'piece-1' } }
            },
          }
        }

        controller.abort()
        const error = new Error('This operation was aborted')
        error.name = 'AbortError'
        throw error
      })
      state.sizesByPieceCid.set('piece-1', 1024)

      const result = await calculateActualStorage(mockSynapse as any, dataSets, {
        signal: controller.signal,
        maxParallelProviders: 1,
      })

      expect(result.timedOut).toBe(true)
      expect(result.totalBytes).toBe(1024n)
      expect(result.dataSetsProcessed).toBe(1)
      expect(result.pieceCount).toBe(1)
      expect(result.warnings.some((w) => w.code === 'CALCULATION_ABORTED')).toBe(true)
    })
  })

  describe('error handling', () => {
    it('should continue processing other datasets when one fails', async () => {
      const dataSets: DataSetSummary[] = [
        {
          dataSetId: 1n,
          providerId: 1,
          serviceProvider: '0xprovider1',
          isLive: true,
          currentPieceCount: 1,
        } as unknown as DataSetSummary,
        {
          dataSetId: 2n,
          providerId: 2,
          serviceProvider: '0xprovider2',
          isLive: true,
          currentPieceCount: 2,
        } as unknown as DataSetSummary,
      ]

      let callCount = 0
      mockCreateStorageContext.mockImplementation(async ({ dataSetId }: { dataSetId: bigint }) => {
        callCount++
        if (callCount === 1) {
          throw new Error('Dataset query failed')
        }

        return {
          dataSetId,
          async getScheduledRemovals() {
            return []
          },
          async *getPieces() {
            yield { pieceId: 1n, pieceCid: { toString: () => 'piece-2' } }
          },
        }
      })
      state.sizesByPieceCid.set('piece-2', 1024)

      const result = await calculateActualStorage(mockSynapse as any, dataSets)

      expect(result.dataSetsProcessed).toBe(1) // Only second dataset succeeded
      expect(result.totalBytes).toBe(1024n)
      expect(result.warnings.some((w) => w.code === 'DATA_SET_QUERY_FAILED')).toBe(true)
    })
  })
})
