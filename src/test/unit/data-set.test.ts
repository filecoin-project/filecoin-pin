import { METADATA_KEYS } from '@filoz/synapse-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataSetSummary } from '../../core/data-set/types.js'
import { runDataSetDetailsCommand, runDataSetListCommand, runTerminateDataSetCommand } from '../../data-set/run.js'

const {
  displayDataSetListMock,
  cleanupSynapseServiceMock,
  spinnerMock,
  cancelMock,
  mockFindDataSets,
  mockGetStorageInfo,
  mockGetAddress,
  mockWarmStorageCreate,
  mockWarmStorageInstance,
  mockSynapseCreate,
  MockPDPServer,
  MockPDPVerifier,
  state,
} = vi.hoisted(() => {
  const displayDataSetListMock = vi.fn()
  const cleanupSynapseServiceMock = vi.fn()
  const cancelMock = vi.fn()
  const spinnerMock = {
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
  }
  const mockFindDataSets = vi.fn()
  const mockGetStorageInfo = vi.fn()
  const mockGetAddress = vi.fn()
  const state = {
    leafCount: 0,
    pieceMetadata: {} as Record<string, string>,
    pieceList: [] as Array<{ pieceId: number; pieceCid: string }>,
  }

  const mockWarmStorageInstance = {
    getPDPVerifierAddress: () => '0xverifier',
    getPieceMetadata: vi.fn(async () => ({ ...state.pieceMetadata })),
  }

  const mockWarmStorageCreate = vi.fn(async () => mockWarmStorageInstance)

  class MockPDPVerifier {
    async getDataSetLeafCount(): Promise<number> {
      return state.leafCount
    }
  }

  class MockPDPServer {
    async getDataSet() {
      return {
        pieces: state.pieceList.map((piece) => ({
          pieceId: piece.pieceId,
          pieceCid: {
            toString: () => piece.pieceCid,
          },
        })),
      }
    }
  }

  const mockStorageContext = {
    dataSetId: 158,
    getPieces: async function* () {
      for (const piece of state.pieceList) {
        yield {
          pieceId: piece.pieceId,
          pieceCid: {
            toString: () => piece.pieceCid,
          },
        }
      }
    },
  }

  const mockCreateContext = vi.fn(async () => mockStorageContext)

  // TODO: we should not need to mock synapseCreate, and should use mocks/synapse-sdk.ts instead
  const mockSynapseCreate = vi.fn(async (config: any) => {
    // Validate auth like the real initializeSynapse does
    const hasStandardAuth = config.privateKey != null
    const hasSessionKeyAuth = config.walletAddress != null && config.sessionKey != null
    const hasViewOnlyAuth = config.readOnly === true && config.walletAddress != null

    if (!hasStandardAuth && !hasSessionKeyAuth && !hasViewOnlyAuth) {
      throw new Error(
        'Authentication required: provide either privateKey, walletAddress + sessionKey, view-address, or signer'
      )
    }

    return {
      getNetwork: () => 'calibration',
      getSigner: () => ({
        getAddress: mockGetAddress,
      }),
      getClient: () => ({
        getAddress: mockGetAddress,
      }),
      storage: {
        findDataSets: mockFindDataSets,
        getStorageInfo: mockGetStorageInfo,
        createContext: mockCreateContext,
      },
      getProvider: () => ({}),
      getWarmStorageAddress: () => '0xwarm',
    }
  })

  return {
    displayDataSetListMock,
    cleanupSynapseServiceMock,
    cancelMock,
    spinnerMock,
    mockFindDataSets,
    mockGetStorageInfo,
    mockGetAddress,
    mockWarmStorageCreate,
    mockWarmStorageInstance,
    mockSynapseCreate,
    mockCreateContext,
    mockStorageContext,
    MockPDPServer,
    MockPDPVerifier,
    state,
  }
})

vi.mock('../../data-set/display.js', () => ({
  displayDataSets: displayDataSetListMock,
}))

vi.mock('../../core/synapse/index.js', () => ({
  initializeSynapse: mockSynapseCreate,
  cleanupSynapseService: cleanupSynapseServiceMock,
}))

vi.mock('../../utils/cli-helpers.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: cancelMock,
  createSpinner: () => spinnerMock,
  isInteractive: () => false,
}))

vi.mock('../../utils/cli-logger.js', () => ({
  log: {
    line: vi.fn(),
    indent: vi.fn(),
    flush: vi.fn(),
    spinnerSection: vi.fn(),
  },
}))

// Use shared SDK mock with custom extensions for dataset command testing
vi.mock('@filoz/synapse-sdk', async () => {
  const sharedMock = await import('../mocks/synapse-sdk.js')
  return {
    ...sharedMock,
    WarmStorageService: { create: mockWarmStorageCreate },
    PDPVerifier: MockPDPVerifier,
    PDPServer: MockPDPServer,
  }
})

// Mock piece size calculation
vi.mock('@filoz/synapse-core/piece', () => ({
  MAX_UPLOAD_SIZE: 1048576,
  getSizeFromPieceCID: vi.fn(() => {
    // Return a realistic piece size (1 MiB = 1048576 bytes)
    return 1048576
  }),
}))

describe('runDataSetCommand', () => {
  const summaryDataSet = {
    pdpVerifierDataSetId: 158,
    providerId: 2,
    isManaged: true,
    withCDN: false,
    currentPieceCount: 3,
    nextPieceId: 3,
    clientDataSetId: 1,
    pdpRailId: 327,
    cdnRailId: 0,
    cacheMissRailId: 0,
    payer: '0x123',
    payee: '0x456',
    serviceProvider: '0xservice',
    commissionBps: 100,
    pdpEndEpoch: 0,
    cdnEndEpoch: 0,
    metadata: {
      [METADATA_KEYS.WITH_IPFS_INDEXING]: '',
      source: 'filecoin-pin',
      note: 'demo',
    },
  }

  const provider = {
    id: 2,
    name: 'Test Provider',
    serviceProvider: '0xservice',
    description: 'demo provider',
    payee: '0x456',
    active: true,
    products: {
      PDP: {
        type: 'PDP',
        isActive: true,
        capabilities: {},
        data: { serviceURL: 'https://pdp.local' },
      },
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    state.leafCount = 0
    state.pieceMetadata = {}
    state.pieceList = []
    mockFindDataSets.mockResolvedValue([summaryDataSet])
    mockGetStorageInfo.mockResolvedValue({ providers: [provider] })
    mockGetAddress.mockResolvedValue('0xabc')
    mockWarmStorageInstance.getPieceMetadata.mockResolvedValue({})
  })

  afterEach(() => {
    delete process.env.PRIVATE_KEY
    process.exitCode = 0
  })

  it('lists datasets without fetching details when no id is provided', async () => {
    await runDataSetListCommand({
      privateKey: 'test-key',
      rpcUrl: 'wss://sample',
    })

    expect(displayDataSetListMock).toHaveBeenCalledTimes(1)
    const firstCall = displayDataSetListMock.mock.calls[0]
    expect(firstCall).toBeDefined()
    const [context] = firstCall as [DataSetSummary[]]
    expect(context).toHaveLength(1)
    const summary = context[0]
    expect(summary).toBeDefined()
    expect(summary?.dataSetId).toBe(158)
    expect(summary?.createdWithFilecoinPin).toBe(true)
  })

  it('filters datasets by metadata entries', async () => {
    await runDataSetListCommand({
      privateKey: 'test-key',
      rpcUrl: 'wss://sample',
      dataSetMetadata: { note: 'demo' },
    })

    const [dataSets] = displayDataSetListMock.mock.calls[0] as [DataSetSummary[]]
    expect(dataSets).toHaveLength(1)
    expect(dataSets[0]?.dataSetId).toBe(158)
  })

  it('excludes datasets that do not match metadata filters', async () => {
    await runDataSetListCommand({
      privateKey: 'test-key',
      rpcUrl: 'wss://sample',
      dataSetMetadata: { note: 'unknown' },
    })

    const [dataSets] = displayDataSetListMock.mock.calls[0] as [DataSetSummary[]]
    expect(dataSets).toHaveLength(0)
  })

  it('loads detailed information when a dataset id is provided', async () => {
    state.pieceList = [{ pieceId: 0, pieceCid: 'bafkpiece0' }]
    const pieceMetadata = {
      [METADATA_KEYS.IPFS_ROOT_CID]: 'bafyroot0',
      custom: 'value',
    }
    state.pieceMetadata = pieceMetadata
    mockWarmStorageInstance.getPieceMetadata.mockResolvedValue(pieceMetadata)

    await runDataSetDetailsCommand(158, {
      privateKey: 'test-key',
      rpcUrl: 'wss://sample',
    })

    expect(displayDataSetListMock).toHaveBeenCalledTimes(1)
    const statusCall = displayDataSetListMock.mock.calls[0]
    expect(statusCall).toBeDefined()
    const [dataSets] = statusCall as [DataSetSummary[]]
    expect(dataSets).toHaveLength(1)
    const dataSet = dataSets[0]
    expect(dataSet).toBeDefined()
    expect(dataSet?.totalSizeBytes).toBe(BigInt(1048576))
    expect(dataSet?.pieces).toBeDefined()
    expect(dataSet?.pieces).toHaveLength(1)
    expect(dataSet?.pieces?.[0]?.size).toBe(1048576)
    expect(dataSet?.pieces?.[0]?.metadata).toMatchObject({
      [METADATA_KEYS.IPFS_ROOT_CID]: 'bafyroot0',
      custom: 'value',
    })
  })

  it('exits when no private key is provided', async () => {
    await expect(runDataSetListCommand({ rpcUrl: 'wss://sample' })).rejects.toThrow('Authentication required')

    // Should call cancel with failure message
    expect(cancelMock).toHaveBeenCalledWith('Listing failed')

    // Should stop spinner with error message
    expect(spinnerMock.stop).toHaveBeenCalledWith(expect.stringContaining('Failed to list data sets'))

    // Should not call display function since it failed early
    expect(displayDataSetListMock).not.toHaveBeenCalled()
  })

  it('terminates dataset when called by owner', async () => {
    mockGetAddress.mockResolvedValue('0x123')

    ;(mockWarmStorageInstance as any).terminateDataSet = vi.fn(async () => ({ hash: '0xdead', blockNumber: 96 }))

    await runTerminateDataSetCommand(158, {
      privateKey: 'test-key',
      rpcUrl: 'wss://sample',
    })

    expect(mockWarmStorageCreate).toHaveBeenCalled()
    expect((mockWarmStorageInstance as any).terminateDataSet).toHaveBeenCalled()

    // Should display dataset before and after termination
    expect(displayDataSetListMock).toHaveBeenCalledTimes(2)
    const lastCall = displayDataSetListMock.mock.calls[displayDataSetListMock.mock.calls.length - 1] as [
      DataSetSummary[],
    ]
    const updated = lastCall[0][0]
    expect(updated).toBeDefined()
    expect(updated?.isLive).toBe(false)
    expect(updated?.pdpEndEpoch).toBe(3)
  })

  it('rejects termination when caller is not owner', async () => {
    mockGetAddress.mockResolvedValue('0x999')

    await runTerminateDataSetCommand(158, {
      privateKey: 'test-key',
      rpcUrl: 'wss://sample',
    })

    expect(cancelMock).toHaveBeenCalledWith('Termination failed')
    expect(spinnerMock.stop).toHaveBeenCalledWith(expect.stringContaining('Permission denied'))
    expect(process.exitCode).toBe(1)
    expect(displayDataSetListMock).not.toHaveBeenCalled()
  })

  it('reports already terminated when pdpEndEpoch > 0', async () => {
    mockFindDataSets.mockResolvedValue([
      {
        ...summaryDataSet,
        pdpEndEpoch: 123,
      },
    ])

    mockGetAddress.mockResolvedValue('0x123')

    await runTerminateDataSetCommand(158, {
      privateKey: 'test-key',
      rpcUrl: 'wss://sample',
    })

    expect(spinnerMock.stop).toHaveBeenCalledWith(expect.stringContaining('already terminated'))
    // Should not attempt to call terminate method on WarmStorageService instance
    if ((mockWarmStorageInstance as any).terminateDataSet) {
      expect((mockWarmStorageInstance as any).terminateDataSet).not.toHaveBeenCalled()
    }
  })
})
