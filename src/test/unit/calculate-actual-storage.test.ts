/**
 * Unit tests for calculateActualStorage
 *
 * Tests abort handling, timeout behavior, and basic calculation correctness.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { calculateActualStorage } from '../../core/data-set/calculate-actual-storage.js'
import type { DataSetSummary } from '../../core/data-set/types.js'

vi.mock('../../core/payments/constants.js', () => ({
  PDP_LEAF_SIZE: 32,
}))

vi.mock('../../core/synapse/index.js', () => ({
  getClientAddress: (synapse: { client: { account: string | { address: string } } }) =>
    typeof synapse.client.account === 'string' ? synapse.client.account : synapse.client.account.address,
}))

// Mock the dependencies
const { mockSynapse, mockWarmStorageInstance, mockWarmStorageCreate, mockGetDataSetLeafCount, state } = vi.hoisted(
  () => {
    const state = {
      leafCount: 0,
    }

    const mockGetDataSetLeafCount = vi.fn(async (_dataSetId: number) => state.leafCount)

    const mockWarmStorageInstance = {
      getPDPVerifierAddress: vi.fn(() => '0xpdp-verifier'),
    }

    const mockWarmStorageCreate = vi.fn(async () => mockWarmStorageInstance)

    const mockSynapse = {
      client: {
        account: {
          address: '0xtest-address' as const,
        },
      },
      getProvider: () => '0xprovider',
      getWarmStorageAddress: () => '0xwarm-storage',
    }

    return {
      mockSynapse,
      mockWarmStorageInstance,
      mockWarmStorageCreate,
      mockGetDataSetLeafCount,
      state,
    }
  }
)

vi.mock('@filoz/synapse-sdk', async () => {
  const sharedMock = await import('../mocks/synapse-sdk.js')
  return {
    ...sharedMock,
    WarmStorageService: { create: mockWarmStorageCreate },
    PDPVerifier: class MockPDPVerifier {
      getDataSetLeafCount = mockGetDataSetLeafCount
    },
  }
})

describe('calculateActualStorage', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    state.leafCount = 0

    mockWarmStorageCreate.mockImplementation(async () => mockWarmStorageInstance)
    mockGetDataSetLeafCount.mockImplementation(async (_dataSetId: number) => state.leafCount)
  })

  describe('basic calculation', () => {
    it('should calculate total storage from multiple data sets', async () => {
      const dataSets: DataSetSummary[] = [
        {
          dataSetId: 1,
          providerId: 1,
          serviceProvider: '0xprovider1',
          isLive: true,
          currentPieceCount: 2,
        } as unknown as DataSetSummary,
        {
          dataSetId: 2,
          providerId: 1,
          serviceProvider: '0xprovider1',
          isLive: true,
          currentPieceCount: 3,
        } as unknown as DataSetSummary,
      ]

      const leavesPerGiB = (1024 * 1024 * 1024) / 32
      state.leafCount = leavesPerGiB * 2

      const result = await calculateActualStorage(mockSynapse as any, dataSets)

      expect(result.dataSetCount).toBe(2)
      expect(result.dataSetsProcessed).toBe(2)
      expect(result.totalBytes).toBe(BigInt(leavesPerGiB) * 2n * 32n * 2n)
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
          dataSetId: 1,
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
  })

  describe('abort handling', () => {
    it('should handle immediate abort', async () => {
      const dataSets: DataSetSummary[] = [
        {
          dataSetId: 1,
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
          dataSetId: 1,
          providerId: 1,
          serviceProvider: '0xprovider1',
          isLive: true,
          currentPieceCount: 1,
        } as unknown as DataSetSummary,
        {
          dataSetId: 2,
          providerId: 2,
          serviceProvider: '0xprovider2',
          isLive: true,
          currentPieceCount: 2,
        } as unknown as DataSetSummary,
      ]

      const controller = new AbortController()

      let callCount = 0
      mockGetDataSetLeafCount.mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return 32
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
          dataSetId: 1,
          providerId: 1,
          serviceProvider: '0xprovider1',
          isLive: true,
          currentPieceCount: 1,
        } as unknown as DataSetSummary,
        {
          dataSetId: 2,
          providerId: 2,
          serviceProvider: '0xprovider2',
          isLive: true,
          currentPieceCount: 2,
        } as unknown as DataSetSummary,
      ]

      let callCount = 0
      mockGetDataSetLeafCount.mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          throw new Error('Dataset query failed')
        }

        return 32
      })

      const result = await calculateActualStorage(mockSynapse as any, dataSets)

      expect(result.dataSetsProcessed).toBe(1) // Only second dataset succeeded
      expect(result.totalBytes).toBe(1024n)
      expect(result.warnings.some((w) => w.code === 'DATA_SET_QUERY_FAILED')).toBe(true)
    })
  })
})
