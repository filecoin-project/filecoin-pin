import { METADATA_KEYS } from '@filoz/synapse-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDataSetCommand } from '../../data-set/run.js'
import type { DataSetDetail, DataSetInspectionContext } from '../../data-set/types.js'

const {
  displayDataSetListMock,
  displayDataSetStatusMock,
  cleanupProviderMock,
  spinnerMock,
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
  const displayDataSetStatusMock = vi.fn()
  const cleanupProviderMock = vi.fn()
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

  const mockSynapseCreate = vi.fn(async () => ({
    getNetwork: () => 'calibration',
    getSigner: () => ({
      getAddress: mockGetAddress,
    }),
    storage: {
      findDataSets: mockFindDataSets,
      getStorageInfo: mockGetStorageInfo,
    },
    getProvider: () => ({}),
    getWarmStorageAddress: () => '0xwarm',
  }))

  return {
    displayDataSetListMock,
    displayDataSetStatusMock,
    cleanupProviderMock,
    spinnerMock,
    mockFindDataSets,
    mockGetStorageInfo,
    mockGetAddress,
    mockWarmStorageCreate,
    mockWarmStorageInstance,
    mockSynapseCreate,
    MockPDPServer,
    MockPDPVerifier,
    state,
  }
})

vi.mock('../../data-set/inspect.js', () => ({
  displayDataSetList: displayDataSetListMock,
  displayDataSetStatus: displayDataSetStatusMock,
}))

vi.mock('../../synapse/service.js', () => ({
  cleanupProvider: cleanupProviderMock,
}))

vi.mock('../../utils/cli-helpers.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  createSpinner: () => spinnerMock,
}))

vi.mock('../../utils/cli-logger.js', () => ({
  log: {
    line: vi.fn(),
    indent: vi.fn(),
    flush: vi.fn(),
  },
}))

vi.mock('@filoz/synapse-sdk', async () => {
  const actual = await vi.importActual<typeof import('@filoz/synapse-sdk')>('@filoz/synapse-sdk')
  return {
    ...actual,
    Synapse: { create: mockSynapseCreate },
    WarmStorageService: { create: mockWarmStorageCreate },
    PDPVerifier: MockPDPVerifier,
    PDPServer: MockPDPServer,
  }
})

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
    metadata: { source: 'filecoin-pin', note: 'demo' },
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
  })

  it('lists datasets without fetching details when no id is provided', async () => {
    await runDataSetCommand(undefined, {
      privateKey: 'test-key',
      rpcUrl: 'wss://sample',
    })

    expect(displayDataSetListMock).toHaveBeenCalledTimes(1)
    const firstCall = displayDataSetListMock.mock.calls[0]
    expect(firstCall).toBeDefined()
    const [context] = firstCall as [DataSetInspectionContext]
    expect(context.dataSets).toHaveLength(1)
    const detail = context.dataSets[0]
    expect(detail).toBeDefined()
    const datasetDetail = detail as DataSetDetail
    expect(datasetDetail.base.pdpVerifierDataSetId).toBe(158)
    expect(datasetDetail.pieces).toHaveLength(0)
    expect(mockWarmStorageCreate).not.toHaveBeenCalled()
    expect(displayDataSetStatusMock).not.toHaveBeenCalled()
  })

  it('loads detailed information when a dataset id is provided', async () => {
    state.leafCount = 256
    state.pieceList = [{ pieceId: 0, pieceCid: 'bafkpiece0' }]
    state.pieceMetadata = {
      [METADATA_KEYS.IPFS_ROOT_CID]: 'bafyroot0',
      custom: 'value',
    }
    mockWarmStorageInstance.getPieceMetadata.mockResolvedValue({ ...state.pieceMetadata })

    await runDataSetCommand('158', {
      ls: true,
      privateKey: 'test-key',
      rpcUrl: 'wss://sample',
    })

    expect(displayDataSetListMock).not.toHaveBeenCalled()

    expect(displayDataSetStatusMock).toHaveBeenCalledTimes(1)
    const statusCall = displayDataSetStatusMock.mock.calls[0]
    expect(statusCall).toBeDefined()
    const [context] = statusCall as [DataSetInspectionContext]
    const detail = context.dataSets[0]
    expect(detail).toBeDefined()
    const datasetDetail = detail as DataSetDetail
    expect(datasetDetail.leafCount).toBe(BigInt(256))
    expect(datasetDetail.totalSizeBytes).toBe(BigInt(256 * 32))
    expect(datasetDetail.pieces).toHaveLength(1)
    const [piece] = datasetDetail.pieces
    expect(piece).toBeDefined()
    expect(piece?.metadata).toMatchObject({
      [METADATA_KEYS.IPFS_ROOT_CID]: 'bafyroot0',
      custom: 'value',
    })
  })

  it('exits when no private key is provided', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })

    await expect(
      runDataSetCommand(undefined, {
        ls: false,
        rpcUrl: 'wss://sample',
      })
    ).rejects.toThrow('process.exit called')

    expect(mockExit).toHaveBeenCalledWith(1)
    mockExit.mockRestore()
  })
})
