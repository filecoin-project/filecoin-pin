import { METADATA_KEYS } from '@filoz/synapse-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataSetSummary } from '../../core/data-set/types.js'
import { runDataSetDetailsCommand, runDataSetListCommand, runTerminateDataSetCommand } from '../../data-set/run.js'

const {
  displayDataSetListMock,
  spinnerMock,
  cancelMock,
  mockFindDataSets,
  mockGetProvider,
  mockGetAllPieceMetadata,
  mockTerminateDataSet,
  mockWaitForTransactionReceipt,
  mockSynapseCreate,
  state,
} = vi.hoisted(() => {
  const displayDataSetListMock = vi.fn()
  const cancelMock = vi.fn()
  const spinnerMock = {
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
    clear: vi.fn(),
  }
  const mockFindDataSets = vi.fn()
  const mockGetProvider = vi.fn()
  const mockGetAllPieceMetadata = vi.fn(async () => ({ ...state.pieceMetadata }))
  const mockTerminateDataSet = vi.fn()
  const mockWaitForTransactionReceipt = vi.fn()
  const state = {
    pieceMetadata: {} as Record<string, string>,
    pieceList: [] as Array<{ pieceId: bigint; pieceCid: string }>,
  }

  const mockCreateContext = vi.fn(async () => ({
    dataSetId: 158n,
    serviceProvider: '0xservice',
    provider: {
      id: 2n,
      name: 'Test Provider',
      serviceProvider: '0xservice',
      pdp: { serviceURL: 'https://provider.example.com' },
    },
    dataSetMetadata: {
      [METADATA_KEYS.WITH_IPFS_INDEXING]: '',
      source: 'filecoin-pin',
      note: 'demo',
    },
    async *getPieces() {
      for (const piece of state.pieceList) {
        yield {
          pieceId: piece.pieceId,
          pieceCid: {
            toString: () => piece.pieceCid,
          },
        }
      }
    },
    getScheduledRemovals: vi.fn(async () => []),
  }))

  const mockSynapseCreate = vi.fn((config: any) => {
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
      chain: { id: 314159, name: 'calibration' },
      client: {
        account: hasViewOnlyAuth ? config.walletAddress : { address: '0xtest-address' },
        waitForTransactionReceipt: mockWaitForTransactionReceipt,
      },
      sessionClient: hasSessionKeyAuth ? {} : undefined,
      storage: {
        findDataSets: mockFindDataSets,
        createContext: mockCreateContext,
        terminateDataSet: mockTerminateDataSet,
      },
      providers: {
        getProvider: mockGetProvider,
      },
    }
  })

  return {
    displayDataSetListMock,
    cancelMock,
    spinnerMock,
    mockFindDataSets,
    mockGetProvider,
    mockGetAllPieceMetadata,
    mockTerminateDataSet,
    mockWaitForTransactionReceipt,
    mockSynapseCreate,
    mockCreateContext,
    state,
  }
})

vi.mock('../../data-set/display.js', () => ({
  displayDataSets: displayDataSetListMock,
}))

vi.mock('../../core/synapse/index.js', () => ({
  initializeSynapse: mockSynapseCreate,
  getClientAddress: () => '0xtest',
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

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(async () => true),
  isCancel: vi.fn(() => false),
}))

// Use shared SDK mock with custom extensions for dataset command testing
vi.mock('@filoz/synapse-sdk', async () => {
  const sharedMock = await import('../mocks/synapse-sdk.js')
  return {
    ...sharedMock,
  }
})

vi.mock('@filoz/synapse-core/warm-storage', () => ({
  getAllPieceMetadata: mockGetAllPieceMetadata,
}))

vi.mock('@filoz/synapse-core/sp', () => ({
  getDataSet: vi.fn(async () => ({
    id: 158n,
    nextChallengeEpoch: 100,
    pieces: state.pieceList.map((p: any) => ({
      pieceId: p.pieceId,
      pieceCid: { toString: () => p.pieceCid },
      subPieceCid: { toString: () => p.pieceCid },
      subPieceOffset: 0,
    })),
  })),
}))

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
    pdpVerifierDataSetId: 158n,
    providerId: 2n,
    isManaged: true,
    withCDN: false,
    currentPieceCount: 3,
    nextPieceId: 3n,
    clientDataSetId: 1n,
    pdpRailId: 327n,
    cdnRailId: 0n,
    cacheMissRailId: 0n,
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
    id: 2n,
    name: 'Test Provider',
    serviceProvider: '0xservice',
    description: 'demo provider',
    payee: '0x456',
    active: true,
    pdp: {
      serviceURL: 'https://pdp.local',
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    state.pieceMetadata = {}
    state.pieceList = []
    mockFindDataSets.mockResolvedValue([summaryDataSet])
    mockGetProvider.mockResolvedValue(provider)
    mockGetAllPieceMetadata.mockResolvedValue({})
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
    expect(summary?.dataSetId).toBe(158n)
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
    expect(dataSets[0]?.dataSetId).toBe(158n)
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
    state.pieceList = [{ pieceId: 0n, pieceCid: 'bafkpiece0' }]
    const pieceMetadata = {
      [METADATA_KEYS.IPFS_ROOT_CID]: 'bafyroot0',
      custom: 'value',
    }
    state.pieceMetadata = pieceMetadata
    mockGetAllPieceMetadata.mockResolvedValue(pieceMetadata)

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
})

describe('runTerminateDataSetCommand', () => {
  const terminatableDataSet = {
    pdpVerifierDataSetId: 158n,
    providerId: 2n,
    isManaged: true,
    withCDN: false,
    isLive: true,
    currentPieceCount: 3,
    nextPieceId: 3n,
    clientDataSetId: 1n,
    pdpRailId: 327n,
    cdnRailId: 0n,
    cacheMissRailId: 0n,
    payer: '0xtest',
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
    id: 2n,
    name: 'Test Provider',
    serviceProvider: '0xservice',
    description: 'demo provider',
    payee: '0x456',
    active: true,
    pdp: {
      serviceURL: 'https://pdp.local',
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    state.pieceMetadata = {}
    state.pieceList = []
    mockFindDataSets.mockResolvedValue([terminatableDataSet])
    mockGetProvider.mockResolvedValue(provider)
    mockGetAllPieceMetadata.mockResolvedValue({})
    mockTerminateDataSet.mockResolvedValue('0xtxhash123')
    mockWaitForTransactionReceipt.mockResolvedValue({ status: 'success' })
  })

  afterEach(() => {
    delete process.env.PRIVATE_KEY
    process.exitCode = 0
  })

  it('terminates a dataset without waiting', async () => {
    await runTerminateDataSetCommand(158, {
      privateKey: 'test-key',
      rpcUrl: 'wss://sample',
    })

    expect(mockTerminateDataSet).toHaveBeenCalledWith({ dataSetId: 158n })
    expect(mockWaitForTransactionReceipt).not.toHaveBeenCalled()
    expect(displayDataSetListMock).toHaveBeenCalledTimes(2)
  })

  it('terminates a dataset and waits for confirmation', async () => {
    // First call returns live dataset, second call (after tx) returns terminated
    const updatedDataSet = { ...terminatableDataSet, isLive: false, pdpEndEpoch: 5000 }
    mockFindDataSets.mockResolvedValueOnce([terminatableDataSet]).mockResolvedValueOnce([updatedDataSet])

    await runTerminateDataSetCommand(158, {
      privateKey: 'test-key',
      rpcUrl: 'wss://sample',
      wait: true,
    })

    expect(mockTerminateDataSet).toHaveBeenCalledWith({ dataSetId: 158n })
    expect(mockWaitForTransactionReceipt).toHaveBeenCalledWith({ hash: '0xtxhash123' })
    expect(displayDataSetListMock).toHaveBeenCalledTimes(2)
  })

  it('rejects termination for read-only accounts', async () => {
    await expect(
      runTerminateDataSetCommand(158, {
        viewAddress: '0xtest',
        rpcUrl: 'wss://sample',
      })
    ).rejects.toThrow('Signing required for termination')

    expect(cancelMock).toHaveBeenCalledWith('Termination failed')
    expect(mockTerminateDataSet).not.toHaveBeenCalled()
  })

  it('rejects when dataset is not owned by the caller', async () => {
    const otherOwnerDataSet = { ...terminatableDataSet, payer: '0xother' }
    mockFindDataSets.mockResolvedValue([otherOwnerDataSet])

    await expect(
      runTerminateDataSetCommand(158, {
        privateKey: 'test-key',
        rpcUrl: 'wss://sample',
      })
    ).rejects.toThrow('not owned by address')

    expect(cancelMock).toHaveBeenCalledWith('Termination failed')
    expect(mockTerminateDataSet).not.toHaveBeenCalled()
  })

  it('reports already-terminated datasets without error', async () => {
    const terminatedDataSet = { ...terminatableDataSet, pdpEndEpoch: 5000 }
    mockFindDataSets.mockResolvedValue([terminatedDataSet])

    await runTerminateDataSetCommand(158, {
      privateKey: 'test-key',
      rpcUrl: 'wss://sample',
    })

    expect(mockTerminateDataSet).not.toHaveBeenCalled()
    expect(cancelMock).not.toHaveBeenCalled()
  })

  it('rejects invalid dataset IDs', async () => {
    await expect(
      runTerminateDataSetCommand(0, {
        privateKey: 'test-key',
        rpcUrl: 'wss://sample',
      })
    ).rejects.toThrow('Invalid data set ID')

    expect(cancelMock).toHaveBeenCalledWith('Termination failed')
  })
})
