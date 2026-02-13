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
  mockFindDataSets,
  mockGetProviders,
  mockGetPieces,
  mockGetAddress,
  mockPDPServerGetDataSet,
  state,
  warmStorageConstructorThrowsRef,
} = vi.hoisted(() => {
  const warmStorageConstructorThrowsRef = { current: false }
  const state = {
    datasets: [] as any[],
    providers: [] as any[],
    pieces: [] as Array<{ pieceId: number; pieceCid: { toString: () => string } }>,
    pieceMetadata: {} as Record<number, Record<string, string>>,
    pdpServerPieces: [] as Array<{ pieceId: number; pieceCid: string }>,
  }

  const mockGetAddress = vi.fn(async () => '0xtest-address')
  const mockFindDataSets = vi.fn(async () => state.datasets)
  const mockGetProviders = vi.fn(async (opts: { providerIds: bigint[] | number[] }) => {
    const ids = opts.providerIds
    return state.providers.filter((p) => ids.some((id) => (typeof id === 'bigint' ? id === BigInt(p.id) : id === p.id)))
  })
  const mockGetPieces = vi.fn(async function* () {
    for (const piece of state.pieces) {
      yield piece
    }
  })
  const mockGetNetwork = vi.fn(() => ({ chainId: 314159n, name: 'calibration' }))
  const mockGetProviderInfo = vi.fn(async () => ({
    products: {
      PDP: {
        data: {
          serviceURL: 'http://localhost:8888/pdp',
        },
      },
    },
  }))
  const mockPDPServerGetDataSet = vi.fn(async (_dataSetId: number) => ({
    pieces: state.pdpServerPieces,
  }))

  const mockWarmStorageInstance = {
    getPieceMetadata: vi.fn(async (opts: { dataSetId: bigint; pieceId: bigint }) => {
      return state.pieceMetadata[Number(opts.pieceId)] ?? {}
    }),
    getServiceProviderRegistryAddress: vi.fn(async () => '0xsp-registry'),
    getPDPVerifierAddress: vi.fn(() => '0xpdp-verifier'),
  }

  const mockWarmStorageCreate = vi.fn(async () => mockWarmStorageInstance)

  const mockStorageContext = {
    dataSetId: 123,
    synapse: null as any, // will be set in tests
    getPieces: mockGetPieces,
    getScheduledRemovals: vi.fn(async () => [] as bigint[]),
    provider: {
      serviceProvider: '0xservice-provider',
      pdp: { serviceURL: 'http://localhost:8888/pdp' },
    },
  }

  const mockSynapse = {
    client: {
      account: { address: '0xtest-address' },
      getAddress: mockGetAddress,
    },
    getClient: () => ({ getAddress: mockGetAddress, account: { address: '0xtest-address' } }),
    getProvider: () => ({}),
    getNetwork: mockGetNetwork,
    getWarmStorageAddress: () => '0xwarm-storage',
    getProviderInfo: mockGetProviderInfo,
    storage: {
      findDataSets: mockFindDataSets,
    },
  }

  return {
    mockSynapse,
    mockStorageContext,
    mockWarmStorageInstance,
    mockWarmStorageCreate,
    mockFindDataSets,
    mockGetProviders,
    mockGetPieces,
    mockGetAddress,
    mockGetProviderInfo,
    mockPDPServerGetDataSet,
    state,
    warmStorageConstructorThrowsRef,
  }
})

vi.mock('@filoz/synapse-sdk', async () => {
  const sharedMock = await import('../mocks/synapse-sdk.js')
  return {
    ...sharedMock,
    PDPServer: class {
      async getDataSet(dataSetId: number) {
        return mockPDPServerGetDataSet(dataSetId)
      }
    },
  }
})

// Production get-data-set-pieces imports WarmStorageService from this subpath.
// Use a constructor function (not class) so we can return the mock instance without noConstructorReturn.
vi.mock('@filoz/synapse-sdk/warm-storage', () => ({
  WarmStorageService: function WarmStorageService(_opts: any) {
    if (warmStorageConstructorThrowsRef.current) {
      throw new Error('WarmStorage unavailable')
    }
    return mockWarmStorageInstance
  },
}))

// Mock piece size calculation
vi.mock('@filoz/synapse-core/sp', () => ({
  getDataSet: vi.fn(async (opts: { serviceURL?: string; dataSetId?: bigint }) => {
    return mockPDPServerGetDataSet(Number(opts.dataSetId ?? 0))
  }),
}))
vi.mock('@filoz/synapse-core/piece', () => ({
  getSizeFromPieceCID: vi.fn((cid: { toString: () => string } | string) => {
    // Map specific CIDs to sizes for testing
    const cidString = typeof cid === 'string' ? cid : cid.toString()
    if (cidString === 'bafkpiece0') return 1048576 // 1 MiB
    if (cidString === 'bafkpiece1') return 2097152 // 2 MiB
    if (cidString === 'bafkpiece2') return 4194304 // 4 MiB
    throw new Error(`Invalid piece CID: ${cidString}`)
  }),
  MAX_UPLOAD_SIZE: 32 * 1024 * 1024 * 1024, // 32 GiB
}))
vi.mock('@filoz/synapse-sdk/sp-registry', () => {
  return {
    SPRegistryService: class {
      async getProviders(opts: { providerIds: bigint[] }) {
        return mockGetProviders(opts)
      }
    },
  }
})

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

  it('lists datasets without provider enrichment when sp-registry fails', async () => {
    const expectedDataSet = {
      pdpVerifierDataSetId: 1,
      clientDataSetId: 100n,
      providerId: 2,
      metadata: { source: 'filecoin-pin' },
      activePieceCount: 5n,
      isManaged: true,
      withCDN: false,
      isLive: true,
      serviceProvider: '0xservice',
      payer: '0xpayer',
      payee: '0xpayee',
    }
    state.datasets = [expectedDataSet]
    mockGetProviders.mockRejectedValueOnce(new Error('Network error'))

    const result = await listDataSets(mockSynapse as any, { withProviderDetails: true })

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      ...expectedDataSet,
      createdWithFilecoinPin: false,
    })
    expect(result[0]?.provider).toBeUndefined()
    expect(mockGetProviders).toHaveBeenCalledWith({ providerIds: [2] })
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
        activePieceCount: 3n,
        isManaged: true,
        withCDN: false,
        isLive: true,
        serviceProvider: '0xservice',
        payer: '0xpayer',
        payee: '0xpayee',
      },
    ]
    state.providers = [provider]

    const result = await listDataSets(mockSynapse as any, { withProviderDetails: true })

    expect(result).toHaveLength(1)
    expect(result[0]?.provider).toEqual(provider)
    expect(result[0]?.createdWithFilecoinPin).toBe(false)
    expect(mockGetProviders).toHaveBeenCalledWith({ providerIds: [2] })
  })

  it('uses custom address when provided in options', async () => {
    await listDataSets(mockSynapse as any, { address: '0xcustom' })

    expect(mockFindDataSets).toHaveBeenCalledWith({ address: '0xcustom' })
    expect(mockGetAddress).not.toHaveBeenCalled()
    expect(mockGetProviders).not.toHaveBeenCalled()
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
        activePieceCount: 2n,
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
        providerId: 999, // Provider not in registry
        metadata: {},
        activePieceCount: 1n,
        isManaged: false,
        withCDN: true,
        isLive: true,
        serviceProvider: '0xservice2',
        payer: '0xpayer',
        payee: '0xpayee',
      },
    ]
    state.providers = [provider1]

    const result = await listDataSets(mockSynapse as any, { withProviderDetails: true })

    expect(result).toHaveLength(2)
    expect(result[0]?.provider).toEqual(provider1)
    expect(result[0]?.createdWithFilecoinPin).toBe(false)
    expect(result[1]?.provider).toBeUndefined()
    expect(result[1]?.createdWithFilecoinPin).toBe(false)
    expect(mockGetProviders).toHaveBeenCalledWith({ providerIds: [1, 999] })
  })

  it('sets createdWithFilecoinPin to true when both WITH_IPFS_INDEXING and source=filecoin-pin metadata are present', async () => {
    state.datasets = [
      {
        pdpVerifierDataSetId: 1,
        clientDataSetId: 100n,
        providerId: 2,
        metadata: {
          [METADATA_KEYS.WITH_IPFS_INDEXING]: '',
          source: 'filecoin-pin',
        },
        activePieceCount: 5n,
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
          source: 'other-tool',
        },
        activePieceCount: 3n,
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
          source: 'filecoin-pin',
        },
        activePieceCount: 2n,
        isManaged: false,
        withCDN: false,
        isLive: true,
        serviceProvider: '0xservice',
        payer: '0xpayer',
        payee: '0xpayee',
      },
    ]
    state.providers = []

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
    state.pieceMetadata = {}
    state.pdpServerPieces = []
    mockStorageContext.synapse = mockSynapse
  })

  it('returns empty array when dataset has no pieces', async () => {
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
    state.pdpServerPieces = [
      { pieceId: 0, pieceCid: 'bafkpiece0' },
      { pieceId: 1, pieceCid: 'bafkpiece1' },
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
  })

  it('enriches pieces with metadata when includeMetadata is true', async () => {
    state.pieces = [
      { pieceId: 0, pieceCid: { toString: () => 'bafkpiece0' } },
      { pieceId: 1, pieceCid: { toString: () => 'bafkpiece1' } },
    ]
    state.pdpServerPieces = [
      { pieceId: 0, pieceCid: 'bafkpiece0' },
      { pieceId: 1, pieceCid: 'bafkpiece1' },
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
  })

  it('handles metadata fetch failures gracefully with warnings', async () => {
    state.pieces = [
      { pieceId: 0, pieceCid: { toString: () => 'bafkpiece0' } },
      { pieceId: 1, pieceCid: { toString: () => 'bafkpiece1' } },
    ]
    // Set pdpServerPieces to match onchain pieces (no orphaned warnings)
    state.pdpServerPieces = [
      { pieceId: 0, pieceCid: 'bafkpiece0' },
      { pieceId: 1, pieceCid: 'bafkpiece1' },
    ]
    state.pieceMetadata = {
      0: {
        [METADATA_KEYS.IPFS_ROOT_CID]: 'bafyroot0',
      },
    }
    // Simulate failure for piece 1
    mockWarmStorageInstance.getPieceMetadata.mockImplementation(
      async (opts: { dataSetId: bigint; pieceId: bigint }) => {
        const pieceId = Number(opts.pieceId)
        if (state.pieceMetadata[pieceId] == null) {
          throw new Error('Metadata not found')
        }
        return state.pieceMetadata[pieceId]
      }
    )

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
    warmStorageConstructorThrowsRef.current = true
    try {
      const result = await getDataSetPieces(mockSynapse as any, mockStorageContext as any, {
        includeMetadata: true,
      })

      expect(result.pieces).toHaveLength(1)
      expect(result.pieces[0]?.metadata).toBeUndefined()
      expect(result.warnings).toBeDefined()
      expect(result.warnings?.length).toBeGreaterThanOrEqual(1)
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          code: 'WARM_STORAGE_INIT_FAILED',
          message: 'Failed to initialize WarmStorageService for metadata enrichment',
          context: { error: 'Error: WarmStorage unavailable' },
        })
      )
    } finally {
      warmStorageConstructorThrowsRef.current = false
    }
  })

  it('throws error when getPieces fails completely', async () => {
    // biome-ignore lint/correctness/useYield: Generator intentionally throws before yielding to test error handling
    mockGetPieces.mockImplementationOnce(async function* () {
      throw new Error('Network error')
    })

    await expect(getDataSetPieces(mockSynapse as any, mockStorageContext as any)).rejects.toThrow(
      'Failed to retrieve pieces for dataset 123'
    )
  })

  it('handles pieces without root IPFS CID in metadata', async () => {
    state.pieces = [{ pieceId: 0, pieceCid: { toString: () => 'bafkpiece0' } }]
    state.pdpServerPieces = [{ pieceId: 0, pieceCid: 'bafkpiece0' }]
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

  it('calculates piece sizes from piece CIDs', async () => {
    state.pieces = [
      { pieceId: 0, pieceCid: { toString: () => 'bafkpiece0' } },
      { pieceId: 1, pieceCid: { toString: () => 'bafkpiece1' } },
    ]
    state.pdpServerPieces = [
      { pieceId: 0, pieceCid: 'bafkpiece0' },
      { pieceId: 1, pieceCid: 'bafkpiece1' },
    ]

    const result = await getDataSetPieces(mockSynapse as any, mockStorageContext as any)

    expect(result.pieces).toHaveLength(2)
    expect(result.pieces[0]?.size).toBe(1048576) // 1 MiB
    expect(result.pieces[1]?.size).toBe(2097152) // 2 MiB
  })

  it('calculates total size as sum of all piece sizes', async () => {
    state.pieces = [
      { pieceId: 0, pieceCid: { toString: () => 'bafkpiece0' } }, // 1 MiB
      { pieceId: 1, pieceCid: { toString: () => 'bafkpiece1' } }, // 2 MiB
      { pieceId: 2, pieceCid: { toString: () => 'bafkpiece2' } }, // 4 MiB
    ]
    state.pdpServerPieces = [
      { pieceId: 0, pieceCid: 'bafkpiece0' },
      { pieceId: 1, pieceCid: 'bafkpiece1' },
      { pieceId: 2, pieceCid: 'bafkpiece2' },
    ]

    const result = await getDataSetPieces(mockSynapse as any, mockStorageContext as any)

    expect(result.pieces).toHaveLength(3)
    expect(result.totalSizeBytes).toBe(BigInt(1048576 + 2097152 + 4194304)) // 7 MiB total
  })

  it('returns undefined totalSizeBytes when no pieces have sizes', async () => {
    state.pieces = []

    const result = await getDataSetPieces(mockSynapse as any, mockStorageContext as any)

    expect(result.pieces).toHaveLength(0)
    expect(result.totalSizeBytes).toBeUndefined()
  })

  it('handles size calculation failures gracefully', async () => {
    state.pieces = [
      { pieceId: 0, pieceCid: { toString: () => 'bafkpiece0' } }, // Valid
      { pieceId: 1, pieceCid: { toString: () => 'invalid-cid' } }, // Will throw
      { pieceId: 2, pieceCid: { toString: () => 'bafkpiece2' } }, // Valid
    ]
    state.pdpServerPieces = [
      { pieceId: 0, pieceCid: 'bafkpiece0' },
      { pieceId: 1, pieceCid: 'invalid-cid' },
      { pieceId: 2, pieceCid: 'bafkpiece2' },
    ]

    const result = await getDataSetPieces(mockSynapse as any, mockStorageContext as any)

    expect(result.pieces).toHaveLength(3)
    expect(result.pieces[0]?.size).toBe(1048576)
    expect(result.pieces[1]?.size).toBeUndefined() // Size calculation failed
    expect(result.pieces[2]?.size).toBe(4194304)
    // Total should only include pieces with valid sizes
    expect(result.totalSizeBytes).toBe(BigInt(1048576 + 4194304))
  })

  it('adds ONCHAIN_ORPHANED warning when piece is on-chain but not reported by provider', async () => {
    state.pieces = [
      { pieceId: 0, pieceCid: { toString: () => 'bafkpiece0' } },
      { pieceId: 1, pieceCid: { toString: () => 'bafkpiece1' } },
    ]
    // PDPServer only reports piece 0, so piece 1 will be flagged as ONCHAIN_ORPHANED
    state.pdpServerPieces = [{ pieceId: 0, pieceCid: 'bafkpiece0' }]

    const result = await getDataSetPieces(mockSynapse as any, mockStorageContext as any)

    expect(result.pieces).toHaveLength(2)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings?.[0]).toMatchObject({
      code: 'ONCHAIN_ORPHANED',
      message: 'Piece is on-chain but the provider does not report it',
      context: {
        pieceId: 1,
        pieceCid: { toString: expect.any(Function) },
      },
    })
  })

  it('adds OFFCHAIN_ORPHANED warning when piece is reported by provider but not on-chain', async () => {
    state.pieces = [{ pieceId: 0, pieceCid: { toString: () => 'bafkpiece0' } }]
    // PDPServer reports 2 pieces, but only piece 0 is on-chain
    state.pdpServerPieces = [
      { pieceId: 0, pieceCid: 'bafkpiece0' },
      { pieceId: 1, pieceCid: 'bafkpiece1' },
    ]

    const result = await getDataSetPieces(mockSynapse as any, mockStorageContext as any)

    // Should have 2 pieces: 1 from on-chain and 1 from provider
    expect(result.pieces).toHaveLength(2)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings?.[0]).toMatchObject({
      code: 'OFFCHAIN_ORPHANED',
      message: 'Piece is reported by provider but not on-chain',
      context: {
        pieceId: 1,
        pieceCid: 'bafkpiece1',
      },
    })
  })

  it('handles both ONCHAIN_ORPHANED and OFFCHAIN_ORPHANED warnings in same result', async () => {
    state.pieces = [
      { pieceId: 0, pieceCid: { toString: () => 'bafkpiece0' } },
      { pieceId: 2, pieceCid: { toString: () => 'bafkpiece2' } },
    ]
    // PDPServer reports pieces 0 and 1, but on-chain has pieces 0 and 2
    state.pdpServerPieces = [
      { pieceId: 0, pieceCid: 'bafkpiece0' },
      { pieceId: 1, pieceCid: 'bafkpiece1' },
    ]

    const result = await getDataSetPieces(mockSynapse as any, mockStorageContext as any)

    // Should have 3 pieces total: 0 (active), 1 (offchain orphaned), 2 (onchain orphaned)
    expect(result.pieces).toHaveLength(3)
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings).toContainEqual({
      code: 'ONCHAIN_ORPHANED',
      message: 'Piece is on-chain but the provider does not report it',
      context: {
        pieceId: 2,
        pieceCid: { toString: expect.any(Function) },
      },
    })
    expect(result.warnings).toContainEqual({
      code: 'OFFCHAIN_ORPHANED',
      message: 'Piece is reported by provider but not on-chain',
      context: {
        pieceId: 1,
        pieceCid: 'bafkpiece1',
      },
    })
  })
})
