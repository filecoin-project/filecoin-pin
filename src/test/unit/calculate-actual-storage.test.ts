/**
 * Unit tests for calculateActualStorage
 *
 * Tests abort handling, timeout behavior, and aggregate data set size calculation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { calculateActualStorage } from '../../core/data-set/calculate-actual-storage.js'
import type { DataSetSummary } from '../../core/data-set/types.js'

const { mockSynapse, mockGetDataSetLeafCounts, defaultGetDataSetLeafCounts, state } = vi.hoisted(() => {
  const state = {
    leafCounts: new Map<bigint, bigint>(),
  }

  const defaultGetDataSetLeafCounts = async (_client: unknown, _options: { dataSetIds: bigint[] }) => state.leafCounts

  const mockGetDataSetLeafCounts = vi.fn(defaultGetDataSetLeafCounts)

  const mockSynapse = {
    client: {
      account: {
        address: '0xtest-address' as const,
      },
    },
  }

  return {
    mockSynapse,
    mockGetDataSetLeafCounts,
    defaultGetDataSetLeafCounts,
    state,
  }
})

vi.mock('@filoz/synapse-core/pdp-verifier', () => ({
  getDataSetLeafCounts: mockGetDataSetLeafCounts,
}))

function dataSet(dataSetId: bigint, providerId = 1n): DataSetSummary {
  return {
    dataSetId,
    providerId,
    serviceProvider: `0xprovider${providerId}`,
    isLive: true,
  } as unknown as DataSetSummary
}

describe('calculateActualStorage', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    state.leafCounts = new Map()

    mockGetDataSetLeafCounts.mockImplementation(defaultGetDataSetLeafCounts)
  })

  describe('basic calculation', () => {
    it('calculates total storage from aggregate data set sizes', async () => {
      const dataSets = [dataSet(1n), dataSet(2n)]

      state.leafCounts = new Map([
        [1n, 4n],
        [2n, 8n],
      ])

      const result = await calculateActualStorage(mockSynapse as any, dataSets)

      expect(mockGetDataSetLeafCounts).toHaveBeenCalledTimes(1)
      expect(mockGetDataSetLeafCounts).toHaveBeenCalledWith(mockSynapse.client, { dataSetIds: [1n, 2n] })
      expect(result.dataSetCount).toBe(2)
      expect(result.dataSetsProcessed).toBe(2)
      expect(result.totalBytes).toBe(381n)
      expect(result.pieceCount).toBe(0)
      expect(result.timedOut).toBeFalsy()
      expect(result.warnings).toHaveLength(0)
    })

    it('unexpands FR32 leaf bytes to the aggregate raw byte approximation', async () => {
      const dataSets = [dataSet(1n), dataSet(2n), dataSet(3n)]

      state.leafCounts = new Map([
        [1n, 1n],
        [2n, 4n],
        [3n, 32n],
      ])

      const result = await calculateActualStorage(mockSynapse as any, dataSets)

      expect(result.totalBytes).toBe(31n + 127n + 1016n)
    })

    it('handles empty data sets without querying chain', async () => {
      const result = await calculateActualStorage(mockSynapse as any, [])

      expect(mockGetDataSetLeafCounts).not.toHaveBeenCalled()
      expect(result.dataSetCount).toBe(0)
      expect(result.dataSetsProcessed).toBe(0)
      expect(result.totalBytes).toBe(0n)
      expect(result.pieceCount).toBe(0)
      expect(result.timedOut).toBeFalsy()
    })

    it('naturally excludes off-chain orphaned pieces because only on-chain data set sizes are queried', async () => {
      const dataSets = [dataSet(1n)]

      state.leafCounts = new Map([[1n, 4n]])

      const result = await calculateActualStorage(mockSynapse as any, dataSets)

      expect(result.totalBytes).toBe(127n)
      expect(result.warnings).toHaveLength(0)
    })

    it('emits one progress event after the aggregate query completes', async () => {
      const onProgress = vi.fn()
      const dataSets = [dataSet(1n), dataSet(2n)]

      state.leafCounts = new Map([
        [1n, 4n],
        [2n, 8n],
      ])

      await calculateActualStorage(mockSynapse as any, dataSets, { onProgress })

      expect(onProgress).toHaveBeenCalledWith({
        type: 'actual-storage:progress',
        data: {
          dataSetsProcessed: 2,
          dataSetCount: 2,
          pieceCount: 0,
          totalBytes: 381n,
        },
      })
    })
  })

  describe('abort handling', () => {
    it('handles immediate abort', async () => {
      const controller = new AbortController()
      controller.abort()

      const result = await calculateActualStorage(mockSynapse as any, [dataSet(1n)], {
        signal: controller.signal,
      })

      expect(mockGetDataSetLeafCounts).not.toHaveBeenCalled()
      expect(result.timedOut).toBe(true)
      expect(result.dataSetsProcessed).toBe(0)
      expect(result.warnings.some((w) => w.code === 'CALCULATION_ABORTED')).toBe(true)
    })

    it('returns an aborted result if the signal fires during the aggregate query', async () => {
      const controller = new AbortController()

      mockGetDataSetLeafCounts.mockImplementationOnce(async () => {
        controller.abort()
        return new Map([[1n, 4n]])
      })

      const result = await calculateActualStorage(mockSynapse as any, [dataSet(1n)], {
        signal: controller.signal,
      })

      expect(result.timedOut).toBe(true)
      expect(result.dataSetsProcessed).toBe(0)
      expect(result.totalBytes).toBe(0n)
      expect(result.warnings.some((w) => w.code === 'CALCULATION_ABORTED')).toBe(true)
    })
  })

  describe('error handling', () => {
    it('returns a warning when aggregate data set size query fails', async () => {
      const dataSets = [dataSet(1n), dataSet(2n, 2n)]

      mockGetDataSetLeafCounts.mockRejectedValueOnce(new Error('Dataset query failed'))

      const result = await calculateActualStorage(mockSynapse as any, dataSets)

      expect(result.dataSetsProcessed).toBe(0)
      expect(result.totalBytes).toBe(0n)
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          code: 'DATA_SET_QUERY_FAILED',
          context: expect.objectContaining({
            dataSetIds: ['1', '2'],
            error: 'Dataset query failed',
          }),
        })
      )
    })
  })
})
