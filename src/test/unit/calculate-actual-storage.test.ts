/**
 * Unit tests for calculateActualStorage
 *
 * Tests abort handling, timeout behavior, and aggregate data set size calculation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { calculateActualStorage } from '../../core/data-set/calculate-actual-storage.js'
import type { DataSetSummary } from '../../core/data-set/types.js'

const { mockSynapse, mockGetDataSetSizes, defaultGetDataSetSizes, state } = vi.hoisted(() => {
  const state = {
    expandedSizes: [] as bigint[],
  }

  const defaultGetDataSetSizes = async (_client: unknown, _options: { dataSetIds: bigint[] }) => state.expandedSizes

  const mockGetDataSetSizes = vi.fn(defaultGetDataSetSizes)

  const mockSynapse = {
    client: {
      account: {
        address: '0xtest-address' as const,
      },
    },
  }

  return {
    mockSynapse,
    mockGetDataSetSizes,
    defaultGetDataSetSizes,
    state,
  }
})

vi.mock('@filoz/synapse-core/pdp-verifier', () => ({
  getDataSetSizes: mockGetDataSetSizes,
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
    state.expandedSizes = []

    mockGetDataSetSizes.mockImplementation(defaultGetDataSetSizes)
  })

  describe('basic calculation', () => {
    it('calculates total storage from aggregate data set sizes', async () => {
      const dataSets = [dataSet(1n), dataSet(2n)]

      state.expandedSizes = [128n, 256n]

      const result = await calculateActualStorage(mockSynapse as any, dataSets)

      expect(mockGetDataSetSizes).toHaveBeenCalledTimes(1)
      expect(mockGetDataSetSizes).toHaveBeenCalledWith(mockSynapse.client, { dataSetIds: [1n, 2n] })
      expect(result.dataSetCount).toBe(2)
      expect(result.dataSetsProcessed).toBe(2)
      expect(result.totalBytes).toBe(381n)
      expect(result.pieceCount).toBe(0)
      expect(result.timedOut).toBeFalsy()
      expect(result.warnings).toHaveLength(0)
    })

    it('unexpands FR32 leaf bytes to the aggregate raw byte approximation', async () => {
      const dataSets = [dataSet(1n), dataSet(2n), dataSet(3n)]

      state.expandedSizes = [32n, 128n, 1024n]

      const result = await calculateActualStorage(mockSynapse as any, dataSets)

      expect(result.totalBytes).toBe(31n + 127n + 1016n)
    })

    it('handles empty data sets without querying chain', async () => {
      const result = await calculateActualStorage(mockSynapse as any, [])

      expect(mockGetDataSetSizes).not.toHaveBeenCalled()
      expect(result.dataSetCount).toBe(0)
      expect(result.dataSetsProcessed).toBe(0)
      expect(result.totalBytes).toBe(0n)
      expect(result.pieceCount).toBe(0)
      expect(result.timedOut).toBeFalsy()
    })

    it('naturally excludes off-chain orphaned pieces because only on-chain data set sizes are queried', async () => {
      const dataSets = [dataSet(1n)]

      state.expandedSizes = [128n]

      const result = await calculateActualStorage(mockSynapse as any, dataSets)

      expect(result.totalBytes).toBe(127n)
      expect(result.warnings).toHaveLength(0)
    })

    it('emits one progress event after the aggregate query completes', async () => {
      const onProgress = vi.fn()
      const dataSets = [dataSet(1n), dataSet(2n)]

      state.expandedSizes = [128n, 256n]

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

      expect(mockGetDataSetSizes).not.toHaveBeenCalled()
      expect(result.timedOut).toBe(true)
      expect(result.dataSetsProcessed).toBe(0)
      expect(result.warnings.some((w) => w.code === 'CALCULATION_ABORTED')).toBe(true)
    })

    it('returns an aborted result if the signal fires during the aggregate query', async () => {
      const controller = new AbortController()

      mockGetDataSetSizes.mockImplementationOnce(async () => {
        controller.abort()
        return [128n]
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

      mockGetDataSetSizes.mockRejectedValueOnce(new Error('Dataset query failed'))

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
