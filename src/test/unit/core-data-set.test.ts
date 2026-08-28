/**
 * Unit tests for core/data-set module
 *
 * Tests the reusable data-set functions that wrap synapse-sdk methods.
 */

import { METADATA_KEYS } from '@filoz/synapse-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDataSetPieces, iterateDataSetPieces, listDataSets, type PieceInfo } from '../../core/data-set/index.js'

const TEST_DATA_SET_ID = 123n
const TEST_SERVICE_URL = 'https://provider.example.com'

const {
  mockSynapse,
  mockFindDataSets,
  mockGetProviders,
  mockGetActivePiecesByCursor,
  mockGetScheduledRemovals,
  mockGetProviderDataSet,
  mockPieceFromCID,
  state,
} = vi.hoisted(() => {
  const state = {
    datasets: [] as any[],
    providers: [] as any[],
    pieces: [] as Array<{ pieceId: bigint; pieceCid: { toString: () => string } }>,
    providerPieces: undefined as
      | Array<{
          pieceId: bigint
          pieceCid: { toString: () => string }
          subPieceCid: { toString: () => string }
          subPieceOffset: number
        }>
      | null
      | undefined,
  }

  const mockFindDataSets = vi.fn(async () => state.datasets)
  const mockGetProviders = vi.fn(async ({ providerIds }: { providerIds: any[] }) => {
    return state.providers.filter((p) => providerIds.includes(p.id))
  })
  const mockGetActivePiecesByCursor = vi.fn(
    async (
      _client: any,
      _args: any
    ): Promise<{
      items: Array<{ id: bigint; cid: { toString: () => string } }>
      nextCursor?: bigint
    }> => ({
      items: state.pieces.map((p) => ({ id: p.pieceId, cid: p.pieceCid })),
    })
  )
  const mockGetScheduledRemovals = vi.fn(async () => [] as readonly bigint[])
  const mockGetProviderDataSet = vi.fn(async () => {
    if (state.providerPieces === null) throw new Error('Provider unavailable')
    // When providerPieces is explicitly set, use it; otherwise mirror on-chain pieces
    const pieces =
      state.providerPieces !== undefined
        ? state.providerPieces
        : state.pieces.map((p) => ({ ...p, subPieceCid: p.pieceCid, subPieceOffset: 0 }))
    return { id: 123n, nextChallengeEpoch: 100, pieces }
  })

  const mockPieceFromCID = vi.fn((cid: { toString: () => string } | string) => {
    const cidString = typeof cid === 'string' ? cid : cid.toString()
    if (cidString === 'bafkpiece0') return { size: 1048576 }
    if (cidString === 'bafkpiece1') return { size: 2097152 }
    if (cidString === 'bafkpiece2') return { size: 4194304 }
    throw new Error(`Invalid piece CID: ${cidString}`)
  })

  const mockSynapse = {
    client: { account: { address: '0xtest-address' as const } },
    chain: { id: 314159, name: 'calibration' },
    providers: { getProviders: mockGetProviders },
    storage: { findDataSets: mockFindDataSets },
  }

  return {
    mockSynapse,
    mockFindDataSets,
    mockGetProviders,
    mockGetActivePiecesByCursor,
    mockGetScheduledRemovals,
    mockGetProviderDataSet,
    mockPieceFromCID,
    state,
  }
})

vi.mock('@filoz/synapse-sdk', async () => {
  const sharedMock = await import('../mocks/synapse-sdk.js')
  return {
    ...sharedMock,
  }
})

vi.mock('@filoz/synapse-core/pdp-verifier', () => ({
  getActivePiecesByCursor: mockGetActivePiecesByCursor,
  getScheduledRemovals: mockGetScheduledRemovals,
}))

vi.mock('@filoz/synapse-core/sp', () => ({
  getDataSet: mockGetProviderDataSet,
}))

// Mock piece size calculation
vi.mock('@filoz/synapse-core/piece', () => ({
  from: mockPieceFromCID,
  MAX_UPLOAD_SIZE: 32 * 1024 * 1024 * 1024, // 32 GiB
}))

describe('listDataSets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.datasets = []
    state.providers = []
  })

  it('returns empty array when no datasets exist', async () => {
    const result = await listDataSets(mockSynapse as any)

    expect(result).toEqual([])
    expect(mockFindDataSets).toHaveBeenCalledWith({ address: '0xtest-address' })
    expect(mockGetProviders).not.toHaveBeenCalled()
  })

  it('uses custom address when provided in options', async () => {
    await listDataSets(mockSynapse as any, { address: '0xcustom' })

    expect(mockFindDataSets).toHaveBeenCalledWith({ address: '0xcustom' })
    expect(mockGetProviders).not.toHaveBeenCalled()
  })

  it('sets createdWithFilecoinPin to true when both WITH_IPFS_INDEXING and source=filecoin-pin metadata are present', async () => {
    state.datasets = [
      {
        pdpVerifierDataSetId: 1,
        clientDataSetId: 100n,
        providerId: 2,
        metadata: {
          [METADATA_KEYS.WITH_IPFS_INDEXING]: '',
          [METADATA_KEYS.SOURCE]: 'filecoin-pin',
        },
        currentPieceCount: 5,
        isManaged: true,
        withCDN: false,
        isLive: true,
        serviceProvider: '0xservice',
        payer: '0xpayer',
        payee: '0xpayee',
      },
      {
        pdpVerifierDataSetId: 2,
        clientDataSetId: 101n,
        providerId: 2,
        metadata: {
          // Has WITH_IPFS_INDEXING but wrong source
          [METADATA_KEYS.WITH_IPFS_INDEXING]: '',
          [METADATA_KEYS.SOURCE]: 'other-tool',
        },
        currentPieceCount: 3,
        isManaged: false,
        withCDN: false,
        isLive: true,
        serviceProvider: '0xservice',
        payer: '0xpayer',
        payee: '0xpayee',
      },
      {
        pdpVerifierDataSetId: 3,
        clientDataSetId: 102n,
        providerId: 2,
        metadata: {
          // Has source but no WITH_IPFS_INDEXING
          [METADATA_KEYS.SOURCE]: 'filecoin-pin',
        },
        currentPieceCount: 2,
        isManaged: false,
        withCDN: false,
        isLive: true,
        serviceProvider: '0xservice',
        payer: '0xpayer',
        payee: '0xpayee',
      },
    ]

    const result = await listDataSets(mockSynapse as any)

    expect(result).toHaveLength(3)
    expect(result[0]?.createdWithFilecoinPin).toBe(true)
    expect(result[1]?.createdWithFilecoinPin).toBe(false)
    expect(result[2]?.createdWithFilecoinPin).toBe(false)
  })
})

describe('getDataSetPieces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.pieces = []
    state.providerPieces = undefined
    mockGetActivePiecesByCursor.mockImplementation(async () => ({
      items: state.pieces.map((p) => ({ id: p.pieceId, cid: p.pieceCid })),
    }))
    mockPieceFromCID.mockImplementation((cid: { toString: () => string } | string) => {
      const cidString = typeof cid === 'string' ? cid : cid.toString()
      if (cidString === 'bafkpiece0') return { size: 1048576 }
      if (cidString === 'bafkpiece1') return { size: 2097152 }
      if (cidString === 'bafkpiece2') return { size: 4194304 }
      throw new Error(`Invalid piece CID: ${cidString}`)
    })
  })

  it('returns empty array when dataset has no pieces', async () => {
    const result = await getDataSetPieces(mockSynapse as any, TEST_DATA_SET_ID, TEST_SERVICE_URL)

    expect(result.pieces).toEqual([])
    expect(result.dataSetId).toBe(123n)
    expect(result.warnings).toEqual([])
  })

  it('retrieves pieces', async () => {
    state.pieces = [
      { pieceId: 0n, pieceCid: { toString: () => 'bafkpiece0' } },
      { pieceId: 1n, pieceCid: { toString: () => 'bafkpiece1' } },
    ]

    const result = await getDataSetPieces(mockSynapse as any, TEST_DATA_SET_ID, TEST_SERVICE_URL)

    expect(result.pieces).toHaveLength(2)
    expect(result.pieces[0]).toMatchObject({
      pieceId: 0n,
      pieceCid: 'bafkpiece0',
    })
    expect(result.pieces[1]).toMatchObject({
      pieceId: 1n,
      pieceCid: 'bafkpiece1',
    })
  })

  it('throws error when getPieces fails completely', async () => {
    mockGetActivePiecesByCursor.mockRejectedValueOnce(new Error('Network error'))

    await expect(getDataSetPieces(mockSynapse as any, TEST_DATA_SET_ID, TEST_SERVICE_URL)).rejects.toThrow(
      'Failed to retrieve pieces for dataset 123'
    )
  })

  it('calculates piece sizes from piece CIDs', async () => {
    const firstCid = { toString: () => 'bafkpiece0' }
    const secondCid = { toString: () => 'bafkpiece1' }
    state.pieces = [
      { pieceId: 0n, pieceCid: firstCid },
      { pieceId: 1n, pieceCid: secondCid },
    ]

    const result = await getDataSetPieces(mockSynapse as any, TEST_DATA_SET_ID, TEST_SERVICE_URL)

    expect(result.pieces).toHaveLength(2)
    expect(result.pieces[0]?.size).toBe(1048576) // 1 MiB
    expect(result.pieces[1]?.size).toBe(2097152) // 2 MiB
    expect(mockPieceFromCID).toHaveBeenNthCalledWith(1, firstCid)
    expect(mockPieceFromCID).toHaveBeenNthCalledWith(2, secondCid)
  })

  it('calculates total size as sum of all piece sizes', async () => {
    state.pieces = [
      { pieceId: 0n, pieceCid: { toString: () => 'bafkpiece0' } }, // 1 MiB
      { pieceId: 1n, pieceCid: { toString: () => 'bafkpiece1' } }, // 2 MiB
      { pieceId: 2n, pieceCid: { toString: () => 'bafkpiece2' } }, // 4 MiB
    ]

    const result = await getDataSetPieces(mockSynapse as any, TEST_DATA_SET_ID, TEST_SERVICE_URL)

    expect(result.pieces).toHaveLength(3)
    expect(result.totalSizeBytes).toBe(BigInt(1048576 + 2097152 + 4194304)) // 7 MiB total
  })

  it('returns undefined totalSizeBytes when no pieces have sizes', async () => {
    state.pieces = []

    const result = await getDataSetPieces(mockSynapse as any, TEST_DATA_SET_ID, TEST_SERVICE_URL)

    expect(result.pieces).toHaveLength(0)
    expect(result.totalSizeBytes).toBeUndefined()
  })

  it('handles size calculation failures gracefully', async () => {
    state.pieces = [
      { pieceId: 0n, pieceCid: { toString: () => 'bafkpiece0' } }, // Valid
      { pieceId: 1n, pieceCid: { toString: () => 'invalid-cid' } }, // Will throw
      { pieceId: 2n, pieceCid: { toString: () => 'bafkpiece2' } }, // Valid
    ]

    const result = await getDataSetPieces(mockSynapse as any, TEST_DATA_SET_ID, TEST_SERVICE_URL)

    expect(result.pieces).toHaveLength(3)
    expect(result.pieces[0]?.size).toBe(1048576)
    expect(result.pieces[1]?.size).toBeUndefined() // Size calculation failed
    expect(result.pieces[2]?.size).toBe(4194304)
    // Total should only include pieces with valid sizes
    expect(result.totalSizeBytes).toBe(BigInt(1048576 + 4194304))
  })

  it('marks pieces as ACTIVE when provider confirms them', async () => {
    const cid0 = { toString: () => 'bafkpiece0' }
    const cid1 = { toString: () => 'bafkpiece1' }
    state.pieces = [
      { pieceId: 0n, pieceCid: cid0 },
      { pieceId: 1n, pieceCid: cid1 },
    ]
    state.providerPieces = [
      { pieceId: 0n, pieceCid: cid0, subPieceCid: cid0, subPieceOffset: 0 },
      { pieceId: 1n, pieceCid: cid1, subPieceCid: cid1, subPieceOffset: 0 },
    ]

    const result = await getDataSetPieces(mockSynapse as any, TEST_DATA_SET_ID, TEST_SERVICE_URL)

    expect(result.pieces).toHaveLength(2)
    expect(result.pieces[0]?.status).toBe('ACTIVE')
    expect(result.pieces[1]?.status).toBe('ACTIVE')
    expect(result.warnings).toHaveLength(0)
  })

  it('marks on-chain pieces missing from provider as ONCHAIN_ORPHANED', async () => {
    const cid0 = { toString: () => 'bafkpiece0' }
    const cid1 = { toString: () => 'bafkpiece1' }
    state.pieces = [
      { pieceId: 0n, pieceCid: cid0 },
      { pieceId: 1n, pieceCid: cid1 },
    ]
    // Provider only knows about piece 0
    state.providerPieces = [{ pieceId: 0n, pieceCid: cid0, subPieceCid: cid0, subPieceOffset: 0 }]

    const result = await getDataSetPieces(mockSynapse as any, TEST_DATA_SET_ID, TEST_SERVICE_URL)

    expect(result.pieces).toHaveLength(2)
    expect(result.pieces[0]?.status).toBe('ACTIVE')
    expect(result.pieces[1]?.status).toBe('ONCHAIN_ORPHANED')
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'ONCHAIN_ORPHANED' }))
  })

  it('adds OFFCHAIN_ORPHANED pieces reported by provider but not on-chain', async () => {
    const cid0 = { toString: () => 'bafkpiece0' }
    const cid1 = { toString: () => 'bafkpiece1' }
    // Only piece 0 is on-chain
    state.pieces = [{ pieceId: 0n, pieceCid: cid0 }]
    // Provider reports both pieces
    state.providerPieces = [
      { pieceId: 0n, pieceCid: cid0, subPieceCid: cid0, subPieceOffset: 0 },
      { pieceId: 1n, pieceCid: cid1, subPieceCid: cid1, subPieceOffset: 0 },
    ]

    const result = await getDataSetPieces(mockSynapse as any, TEST_DATA_SET_ID, TEST_SERVICE_URL)

    expect(result.pieces).toHaveLength(2)
    expect(result.pieces[0]?.status).toBe('ACTIVE')
    // piece 1 is an offchain orphan (provider reports it, not on-chain)
    const offchainOrphan = result.pieces.find((p) => p.pieceId === 1n)
    expect(offchainOrphan?.status).toBe('OFFCHAIN_ORPHANED')
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'OFFCHAIN_ORPHANED' }))
  })

  it('falls back to ACTIVE when provider query fails', async () => {
    state.pieces = [{ pieceId: 0n, pieceCid: { toString: () => 'bafkpiece0' } }]
    state.providerPieces = null // triggers the mock to throw

    const result = await getDataSetPieces(mockSynapse as any, TEST_DATA_SET_ID, TEST_SERVICE_URL)

    expect(result.pieces).toHaveLength(1)
    expect(result.pieces[0]?.status).toBe('ACTIVE')
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'PROVIDER_PIECES_UNAVAILABLE' }))
  })

  it('passes opaque getActivePiecesByCursor cursors through unchanged', async () => {
    const pages: Record<string, Array<{ id: bigint; cid: { toString: () => string } }>> = {
      '0': [{ id: 0n, cid: { toString: () => 'bafkpiece0' } }],
      '7': [{ id: 7n, cid: { toString: () => 'bafkpiece1' } }],
      '53': [{ id: 53n, cid: { toString: () => 'bafkpiece2' } }],
    }
    const nextCursors: Record<string, bigint | undefined> = { '0': 7n, '7': 53n }
    mockGetActivePiecesByCursor.mockImplementation((async (_client: any, { cursor }: any) => ({
      items: pages[String(cursor)] ?? [],
      nextCursor: nextCursors[String(cursor)],
    })) as any)

    const result = await getDataSetPieces(mockSynapse as any, TEST_DATA_SET_ID, TEST_SERVICE_URL)

    expect(mockGetActivePiecesByCursor).toHaveBeenCalledTimes(3)
    expect(mockGetActivePiecesByCursor.mock.calls.map((c: any) => c[1].cursor)).toEqual([0n, 7n, 53n])
    expect((mockGetActivePiecesByCursor.mock.calls[0] as any)?.[1].limit).toBe(100n)
    expect(result.pieces.map((p) => p.pieceId)).toEqual([0n, 7n, 53n])
  })

  it('rejects a non-advancing getActivePiecesByCursor cursor', async () => {
    mockGetActivePiecesByCursor.mockResolvedValue({
      items: [],
      nextCursor: 0n,
    })

    await expect(getDataSetPieces(mockSynapse as any, TEST_DATA_SET_ID, TEST_SERVICE_URL)).rejects.toThrow(
      '`nextCursor` must advance beyond the current cursor.'
    )
    expect(mockGetActivePiecesByCursor).toHaveBeenCalledTimes(1)
  })

  it('stops paginating when the abort signal fires', async () => {
    const controller = new AbortController()
    let calls = 0
    mockGetActivePiecesByCursor.mockImplementation((async () => {
      calls++
      if (calls === 2) controller.abort()
      return { items: [], nextCursor: BigInt(calls) }
    }) as any)

    await expect(
      getDataSetPieces(mockSynapse as any, TEST_DATA_SET_ID, TEST_SERVICE_URL, { signal: controller.signal })
    ).rejects.toThrow()
    // The loop checks the signal before each page, so it stops after the aborting call
    expect(calls).toBe(2)
  })
})

describe('iterateDataSetPieces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.pieces = []
    state.providerPieces = undefined
  })

  it('does not fetch the next on-chain batch until the consumer asks for it', async () => {
    const pages: Record<string, Array<{ id: bigint; cid: { toString: () => string } }>> = {
      '0': [{ id: 0n, cid: { toString: () => 'bafkpiece0' } }],
      '100': [{ id: 1n, cid: { toString: () => 'bafkpiece1' } }],
    }
    mockGetActivePiecesByCursor.mockImplementation((async (_client: any, { cursor }: any) => ({
      items: pages[String(cursor)] ?? [],
      ...(cursor === 0n ? { nextCursor: 100n } : {}),
    })) as any)

    const iterator = iterateDataSetPieces(mockSynapse as any, TEST_DATA_SET_ID, TEST_SERVICE_URL)
    const first = await iterator.next()

    expect(mockGetActivePiecesByCursor).toHaveBeenCalledTimes(1)
    expect(first.done).toBe(false)
    expect(first.value?.hasMore).toBe(true)
    expect(first.value?.pieces.map((p: PieceInfo) => p.pieceId)).toEqual([0n])

    const second = await iterator.next()
    expect(mockGetActivePiecesByCursor).toHaveBeenCalledTimes(2)
    expect(second.value?.hasMore).toBe(false)
  })

  it('only appends OFFCHAIN_ORPHANED leftovers on the final batch', async () => {
    const cid0 = { toString: () => 'bafkpiece0' }
    const cid1 = { toString: () => 'bafkpiece1' }
    const offchainCid = { toString: () => 'bafkorphan' }
    const pages: Record<string, Array<{ id: bigint; cid: { toString: () => string } }>> = {
      '0': [{ id: 0n, cid: cid0 }],
      '100': [{ id: 1n, cid: cid1 }],
    }
    mockGetActivePiecesByCursor.mockImplementation((async (_client: any, { cursor }: any) => ({
      items: pages[String(cursor)] ?? [],
      ...(cursor === 0n ? { nextCursor: 100n } : {}),
    })) as any)
    // Provider reports an extra piece that never shows up on-chain
    state.providerPieces = [
      { pieceId: 0n, pieceCid: cid0, subPieceCid: cid0, subPieceOffset: 0 },
      { pieceId: 1n, pieceCid: cid1, subPieceCid: cid1, subPieceOffset: 0 },
      { pieceId: 2n, pieceCid: offchainCid, subPieceCid: offchainCid, subPieceOffset: 0 },
    ]

    const batches: Array<{ hasMore: boolean; pieceIds: bigint[] }> = []
    for await (const batch of iterateDataSetPieces(mockSynapse as any, TEST_DATA_SET_ID, TEST_SERVICE_URL)) {
      batches.push({ hasMore: batch.hasMore, pieceIds: batch.pieces.map((p) => p.pieceId) })
    }

    expect(batches).toHaveLength(2)
    expect(batches[0]).toEqual({ hasMore: true, pieceIds: [0n] })
    expect(batches[1]?.hasMore).toBe(false)
    expect(batches[1]?.pieceIds).toEqual([1n, 2n])
  })
})
