/**
 * Unit tests for core/data-set module
 *
 * Tests the reusable data-set functions that wrap synapse-sdk methods.
 */

import { METADATA_KEYS } from '@filoz/synapse-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDataSetPieces, listDataSets } from '../../core/data-set/index.js'

const {
  mockSynapse,
  mockStorageContext,
  mockWarmStorageInstance,
  mockWarmStorageCreate,
  mockFindDataSets,
  mockGetStorageInfo,
  mockGetPieces,
  mockGetAddress,
  state,
} = vi.hoisted(() => {
  const state = {
    datasets: [] as any[],
    storageInfo: null as any,
    pieces: [] as Array<{ pieceId: number; pieceCid: { toString: () => string } }>,
    pieceMetadata: {} as Record<number, Record<string, string>>,
  }

  const mockGetAddress = vi.fn(async () => '0xtest-address')
  const mockFindDataSets = vi.fn(async () => state.datasets)
  const mockGetStorageInfo = vi.fn(async () => state.storageInfo)
  const mockGetPieces = vi.fn(async function* () {
    for (const piece of state.pieces) {
      yield piece
    }
  })

  const mockWarmStorageInstance = {
    getPieceMetadata: vi.fn(async (_dataSetId: number, pieceId: number) => {
      return state.pieceMetadata[pieceId] ?? {}
    }),
  }

  const mockWarmStorageCreate = vi.fn(async () => mockWarmStorageInstance)

  const mockStorageContext = {
    dataSetId: 123,
    synapse: null as any, // will be set in tests
    getPieces: mockGetPieces,
  }

  const mockSynapse = {
    getClient: () => ({ getAddress: mockGetAddress }),
    getProvider: () => ({}),
    getWarmStorageAddress: () => '0xwarm-storage',
    storage: {
      findDataSets: mockFindDataSets,
      getStorageInfo: mockGetStorageInfo,
    },
  }

  return {
    mockSynapse,
    mockStorageContext,
    mockWarmStorageInstance,
    mockWarmStorageCreate,
    mockFindDataSets,
    mockGetStorageInfo,
    mockGetPieces,
    mockGetAddress,
    state,
  }
})

vi.mock('@filoz/synapse-sdk', async () => {
  const sharedMock = await import('../mocks/synapse-sdk.js')
  return {
    ...sharedMock,
    WarmStorageService: { create: mockWarmStorageCreate },
  }
})

describe('listDataSets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.datasets = []
    state.storageInfo = null
  })

  it('returns empty array when no datasets exist', async () => {
    state.datasets = []
    state.storageInfo = { providers: [] }

    const result = await listDataSets(mockSynapse as any)

    expect(result).toEqual([])
    expect(mockFindDataSets).toHaveBeenCalledWith('0xtest-address')
    expect(mockGetStorageInfo).toHaveBeenCalled()
  })

  it('lists datasets without provider enrichment when storage info unavailable', async () => {
    state.datasets = [
      {
        pdpVerifierDataSetId: 1,
        clientDataSetId: 100n,
        providerId: 2,
        metadata: { source: 'filecoin-pin' },
        currentPieceCount: 5,
        isManaged: true,
        withCDN: false,
        isLive: true,
        serviceProvider: '0xservice',
        payer: '0xpayer',
        payee: '0xpayee',
      },
    ]
    mockGetStorageInfo.mockRejectedValueOnce(new Error('Network error'))

    const result = await listDataSets(mockSynapse as any)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      dataSetId: 1,
      clientDataSetId: 100n,
      providerId: 2,
      metadata: { source: 'filecoin-pin' },
      currentPieceCount: 5,
      isManaged: true,
      withCDN: false,
      isLive: true,
      serviceProvider: '0xservice',
      payer: '0xpayer',
      payee: '0xpayee',
    })
    expect(result[0]?.provider).toBeUndefined()
  })

  it('enriches datasets with provider information when available', async () => {
    const provider = {
      id: 2,
      name: 'Test Provider',
      serviceProvider: '0xservice',
      description: 'Test provider',
      payee: '0xpayee',
      active: true,
      products: {},
    }

    state.datasets = [
      {
        pdpVerifierDataSetId: 1,
        clientDataSetId: 100n,
        providerId: 2,
        metadata: {},
        currentPieceCount: 3,
        isManaged: true,
        withCDN: false,
        isLive: true,
        serviceProvider: '0xservice',
        payer: '0xpayer',
        payee: '0xpayee',
      },
    ]
    state.storageInfo = { providers: [provider] }

    const result = await listDataSets(mockSynapse as any)

    expect(result).toHaveLength(1)
    expect(result[0]?.provider).toEqual(provider)
  })

  it('uses custom address when provided in options', async () => {
    state.datasets = []
    state.storageInfo = { providers: [] }

    await listDataSets(mockSynapse as any, { address: '0xcustom' })

    expect(mockFindDataSets).toHaveBeenCalledWith('0xcustom')
    expect(mockGetAddress).not.toHaveBeenCalled()
  })

  it('handles multiple datasets with mixed provider availability', async () => {
    const provider1 = {
      id: 1,
      name: 'Provider 1',
      serviceProvider: '0xprovider1',
      description: 'First provider',
      payee: '0xpayee1',
      active: true,
      products: {},
    }

    state.datasets = [
      {
        pdpVerifierDataSetId: 1,
        clientDataSetId: 100n,
        providerId: 1,
        metadata: {},
        currentPieceCount: 2,
        isManaged: true,
        withCDN: false,
        isLive: true,
        serviceProvider: '0xservice1',
        payer: '0xpayer',
        payee: '0xpayee',
      },
      {
        pdpVerifierDataSetId: 2,
        clientDataSetId: 101n,
        providerId: 999, // Provider not in list
        metadata: {},
        currentPieceCount: 1,
        isManaged: false,
        withCDN: true,
        isLive: true,
        serviceProvider: '0xservice2',
        payer: '0xpayer',
        payee: '0xpayee',
      },
    ]
    state.storageInfo = { providers: [provider1] }

    const result = await listDataSets(mockSynapse as any)

    expect(result).toHaveLength(2)
    expect(result[0]?.provider).toEqual(provider1)
    expect(result[1]?.provider).toBeUndefined()
  })
})

describe('getDataSetPieces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.pieces = []
    state.pieceMetadata = {}
    mockStorageContext.synapse = mockSynapse
  })

  it('returns empty array when dataset has no pieces', async () => {
    state.pieces = []

    const result = await getDataSetPieces(mockSynapse as any, mockStorageContext as any)

    expect(result.pieces).toEqual([])
    expect(result.dataSetId).toBe(123)
    expect(result.warnings).toEqual([])
  })

  it('retrieves pieces without metadata when includeMetadata is false', async () => {
    state.pieces = [
      { pieceId: 0, pieceCid: { toString: () => 'bafkpiece0' } },
      { pieceId: 1, pieceCid: { toString: () => 'bafkpiece1' } },
    ]

    const result = await getDataSetPieces(mockSynapse as any, mockStorageContext as any, {
      includeMetadata: false,
    })

    expect(result.pieces).toHaveLength(2)
    expect(result.pieces[0]).toMatchObject({
      pieceId: 0,
      pieceCid: 'bafkpiece0',
    })
    expect(result.pieces[0]?.metadata).toBeUndefined()
    expect(result.pieces[1]).toMatchObject({
      pieceId: 1,
      pieceCid: 'bafkpiece1',
    })
    expect(mockWarmStorageCreate).not.toHaveBeenCalled()
  })

  it('enriches pieces with metadata when includeMetadata is true', async () => {
    state.pieces = [
      { pieceId: 0, pieceCid: { toString: () => 'bafkpiece0' } },
      { pieceId: 1, pieceCid: { toString: () => 'bafkpiece1' } },
    ]
    state.pieceMetadata = {
      0: {
        [METADATA_KEYS.IPFS_ROOT_CID]: 'bafyroot0',
        label: 'test-file-0.txt',
      },
      1: {
        [METADATA_KEYS.IPFS_ROOT_CID]: 'bafyroot1',
        label: 'test-file-1.txt',
      },
    }

    const result = await getDataSetPieces(mockSynapse as any, mockStorageContext as any, {
      includeMetadata: true,
    })

    expect(result.pieces).toHaveLength(2)
    expect(result.pieces[0]).toMatchObject({
      pieceId: 0,
      pieceCid: 'bafkpiece0',
      rootIpfsCid: 'bafyroot0',
      metadata: {
        [METADATA_KEYS.IPFS_ROOT_CID]: 'bafyroot0',
        label: 'test-file-0.txt',
      },
    })
    expect(mockWarmStorageCreate).toHaveBeenCalledWith({}, '0xwarm-storage')
  })

  it('handles metadata fetch failures gracefully with warnings', async () => {
    state.pieces = [
      { pieceId: 0, pieceCid: { toString: () => 'bafkpiece0' } },
      { pieceId: 1, pieceCid: { toString: () => 'bafkpiece1' } },
    ]
    state.pieceMetadata = {
      0: {
        [METADATA_KEYS.IPFS_ROOT_CID]: 'bafyroot0',
      },
    }
    // Simulate failure for piece 1
    mockWarmStorageInstance.getPieceMetadata.mockImplementation(async (_dsId, pieceId) => {
      if (state.pieceMetadata[pieceId] == null) {
        throw new Error('Metadata not found')
      }
      return state.pieceMetadata[pieceId]
    })

    const result = await getDataSetPieces(mockSynapse as any, mockStorageContext as any, {
      includeMetadata: true,
    })

    expect(result.pieces).toHaveLength(2)
    expect(result.pieces[0]?.metadata).toBeDefined()
    expect(result.pieces[1]?.metadata).toBeUndefined()
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings?.[0]).toMatchObject({
      code: 'METADATA_FETCH_FAILED',
      message: 'Failed to fetch metadata for piece 1',
      context: {
        pieceId: 1,
        dataSetId: 123,
      },
    })
  })

  it('adds warning when WarmStorage initialization fails', async () => {
    state.pieces = [{ pieceId: 0, pieceCid: { toString: () => 'bafkpiece0' } }]
    mockWarmStorageCreate.mockRejectedValueOnce(new Error('WarmStorage unavailable'))

    const result = await getDataSetPieces(mockSynapse as any, mockStorageContext as any, {
      includeMetadata: true,
    })

    expect(result.pieces).toHaveLength(1)
    expect(result.pieces[0]?.metadata).toBeUndefined()
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings?.[0]).toMatchObject({
      code: 'WARM_STORAGE_INIT_FAILED',
      message: 'Failed to initialize WarmStorageService for metadata enrichment',
    })
  })

  it('throws error when getPieces fails completely', async () => {
    mockGetPieces.mockImplementationOnce(async function* (): AsyncGenerator<{
      pieceId: number
      pieceCid: { toString: () => string }
    }> {
      yield await Promise.reject(new Error('Network error'))
    })

    await expect(getDataSetPieces(mockSynapse as any, mockStorageContext as any)).rejects.toThrow(
      'Failed to retrieve pieces for dataset 123'
    )
  })

  it('handles pieces without root IPFS CID in metadata', async () => {
    state.pieces = [{ pieceId: 0, pieceCid: { toString: () => 'bafkpiece0' } }]
    state.pieceMetadata = {
      0: {
        label: 'no-cid-file.txt',
        // No IPFS_ROOT_CID
      },
    }

    const result = await getDataSetPieces(mockSynapse as any, mockStorageContext as any, {
      includeMetadata: true,
    })

    expect(result.pieces).toHaveLength(1)
    expect(result.pieces[0]?.rootIpfsCid).toBeUndefined()
    expect(result.pieces[0]?.metadata).toMatchObject({
      label: 'no-cid-file.txt',
    })
  })
})
