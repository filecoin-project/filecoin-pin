import { confirm } from '@clack/prompts'
import { METADATA_KEYS } from '@filoz/synapse-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataSetSummary } from '../../core/data-set/types.js'
import { isViewOnlyMode } from '../../core/synapse/index.js'
import { runDataSetDetailsCommand, runDataSetListCommand, runTerminateDataSetCommand } from '../../data-set/run.js'
import { isInteractive } from '../../utils/cli-helpers.js'

const {
  displayDataSetListMock,
  cleanupSynapseServiceMock,
  spinnerMock,
  cancelMock,
  mockFindDataSets,
  mockGetStorageInfo,
  mockGetAddress,
  mockWaitForTransaction,
  mockWarmStorageCreate,
  mockWarmStorageInstance,
  mockSynapseCreate,
  MockPDPServer,
  MockPDPVerifier,
  MockStorageContext,
  MockSPRegistryService,
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
  const mockWaitForTransaction = vi.fn(async () => ({ status: 1, blockNumber: 96 }))
  const state = {
    leafCount: 0,
    pieceMetadata: {} as Record<string, string>,
    pieceList: [] as Array<{ pieceId: number; pieceCid: string }>,
  }

  const mockWarmStorageInstance = {
    getPDPVerifierAddress: () => '0xverifier',
    getPieceMetadata: vi.fn(async () => ({ ...state.pieceMetadata })),
    getDataSet: vi.fn(async (dataSetId: number) => ({
      dataSetId: BigInt(dataSetId),
      providerId: BigInt(2),
      payer: '0x123',
      payee: '0x456',
      pdpRailId: BigInt(327),
      cdnRailId: BigInt(0),
      cacheMissRailId: BigInt(0),
      commissionBps: 100,
    })),
    getDataSetMetadata: vi.fn(async () => ({
      [METADATA_KEYS.WITH_IPFS_INDEXING]: '',
      source: 'filecoin-pin',
      note: 'demo',
    })),
    getServiceProviderRegistryAddress: () => '0xregistry',
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

  class MockStorageContext {
    dataSetId = 158
    serviceProvider = '0xservice'
    provider = {
      id: BigInt(2),
      name: 'Test Provider',
      serviceProvider: '0xservice',
    }
    async *getPieces() {
      for (const piece of state.pieceList) {
        yield {
          pieceId: piece.pieceId,
          pieceCid: {
            toString: () => piece.pieceCid,
          },
        }
      }
    }
  }

  class MockSPRegistryService {
    async getProvider() {
      return {
        id: BigInt(2),
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
    }
  }

  const mockStorageContext = new MockStorageContext()

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
      getProvider: () => ({
        waitForTransaction: mockWaitForTransaction,
      }),
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
    mockWaitForTransaction,
    mockWarmStorageCreate,
    mockWarmStorageInstance,
    mockSynapseCreate,
    mockCreateContext,
    mockStorageContext,
    MockStorageContext,
    MockSPRegistryService,
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
  isViewOnlyMode: vi.fn(),
}))

vi.mock('../../utils/cli-helpers.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: cancelMock,
  createSpinner: () => spinnerMock,
  isInteractive: vi.fn(() => false),
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
    StorageContext: MockStorageContext,
  }
})

// Mock SPRegistryService for getDetailedDataSet
vi.mock('@filoz/synapse-sdk/sp-registry', () => ({
  SPRegistryService: MockSPRegistryService,
}))

// Mock piece size calculation
vi.mock('@filoz/synapse-core/piece', () => ({
  MAX_UPLOAD_SIZE: 1048576,
  getSizeFromPieceCID: vi.fn(() => {
    // Return a realistic piece size (1 MiB = 1048576 bytes)
    return 1048576
  }),
}))

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
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
    mockWaitForTransaction.mockResolvedValue({ status: 1, blockNumber: 96 })
    mockWarmStorageInstance.getPieceMetadata.mockResolvedValue({})
    ;(mockWarmStorageInstance as any).getDataSet = vi.fn(async (dataSetId: number) => ({
      dataSetId: BigInt(dataSetId),
      providerId: BigInt(2),
      payer: '0x123',
      payee: '0x456',
      pdpRailId: BigInt(327),
      cdnRailId: BigInt(0),
      cacheMissRailId: BigInt(0),
      commissionBps: 100,
    }))
  })

  afterEach(() => {
    delete process.env.PRIVATE_KEY
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
    await runTerminateDataSetCommand(158, {
      privateKey: 'test-key',
      rpcUrl: 'wss://sample',
    })

    expect(cancelMock).toHaveBeenCalledWith('Termination failed')
    expect(spinnerMock.stop).toHaveBeenCalledWith(expect.stringContaining('Permission denied'))
    expect(displayDataSetListMock).not.toHaveBeenCalled()
  })

  it('reports already terminated when pdpEndEpoch > 0', async () => {
    mockGetAddress.mockResolvedValue('0x123')

    ;(mockWarmStorageInstance as any).getDataSet = vi.fn(async () => ({
      dataSetId: BigInt(158),
      providerId: BigInt(2),
      payer: '0x123',
      payee: '0x456',
      pdpRailId: BigInt(327),
      cdnRailId: BigInt(0),
      cacheMissRailId: BigInt(0),
      commissionBps: 100,
      pdpEndEpoch: BigInt(123),
    }))

    ;(mockWarmStorageInstance as any).terminateDataSet = vi.fn(async () => ({ hash: '0xdead', blockNumber: 196 }))

    await expect(
      runTerminateDataSetCommand(158, {
        privateKey: 'test-key',
        rpcUrl: 'wss://sample',
      })
    ).resolves.toBeUndefined()

    expect(spinnerMock.stop).toHaveBeenCalledWith(expect.stringContaining('⚠ Data set already terminated'))
    expect((mockWarmStorageInstance as any).terminateDataSet).not.toHaveBeenCalled()
    expect(cancelMock).not.toHaveBeenCalledWith('Termination failed')
    expect(displayDataSetListMock).not.toHaveBeenCalled()
  })

  it('fails when waited transaction is reverted', async () => {
    mockGetAddress.mockResolvedValue('0x123')

    ;(mockWarmStorageInstance as any).terminateDataSet = vi.fn(async () => ({ hash: '0xdead', blockNumber: 96 }))
    mockWaitForTransaction.mockResolvedValue({ status: 0, blockNumber: 96 })

    await runTerminateDataSetCommand(158, {
      privateKey: 'test-key',
      rpcUrl: 'wss://sample',
      wait: true,
    })

    expect(mockWaitForTransaction).toHaveBeenCalledWith('0xdead')
    expect(displayDataSetListMock).toHaveBeenCalledTimes(1)
    expect(cancelMock).toHaveBeenCalledWith('Termination failed')
  })

  it('rejects termination in view-only mode', async () => {
    vi.mocked(isViewOnlyMode).mockReturnValueOnce(true)

    await runTerminateDataSetCommand(158, { privateKey: 'test-key', rpcUrl: 'wss://sample' })

    expect(cancelMock).toHaveBeenCalledWith('Termination failed')
  })

  it('throws an error for invalid provider ID', async () => {
    await expect(
      runDataSetListCommand({ privateKey: 'test-key', rpcUrl: 'wss://sample', providerId: 'abc' as any })
    ).rejects.toThrow('Invalid provider ID')
    expect(cancelMock).toHaveBeenCalledWith('Listing failed')
  })

  it('cancels termination in interactive mode if user declines', async () => {
    mockGetAddress.mockResolvedValue('0x123')
    vi.mocked(isInteractive).mockReturnValueOnce(true)
    vi.mocked(confirm).mockResolvedValueOnce(false)

    await runTerminateDataSetCommand(158, { privateKey: 'test-key', rpcUrl: 'wss://sample' })

    expect(cancelMock).toHaveBeenCalledWith('Termination cancelled by user')
  })
})
