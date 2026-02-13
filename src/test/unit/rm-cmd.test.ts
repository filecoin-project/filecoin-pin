import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runRmPiece } from '../../rm/remove-piece.js'
import type { RmPieceOptions } from '../../rm/types.js'

const {
  spinner,
  mockIntro,
  mockOutro,
  mockCancel,
  mockCreateSpinner,
  mockParseCLIAuth,
  mockInitializeSynapse,
  mockCreateStorageContext,
  mockCleanupSynapseService,
  mockRemovePiece,
  mockLogSection,
} = vi.hoisted(() => {
  const spinner = {
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
  }

  const mockIntro = vi.fn()
  const mockOutro = vi.fn()
  const mockCancel = vi.fn()
  const mockCreateSpinner = vi.fn(() => spinner)
  // 0.37: parseCLIAuth sets config.account (not privateKey)
  const mockParseCLIAuth = vi.fn(() => ({ account: '0xabc', rpcUrl: 'wss://rpc' }))
  const mockCleanupSynapseService = vi.fn(async () => {
    // no-op for tests
  })
  const mockLogSection = vi.fn()

  const mockInitializeSynapse = vi.fn(async () => ({
    getNetwork: () => 'calibration',
    chain: { name: 'calibration' },
  }))

  const mockStorageContext = { dataSetId: 123 }
  const mockCreateStorageContext = vi.fn(async () => ({ storage: mockStorageContext }))

  const mockRemovePiece = vi.fn(async (_pieceCid: string, _storage: any, opts: { onProgress?: any }) => {
    opts.onProgress?.({
      type: 'remove-piece:submitted',
      data: { pieceCid: _pieceCid, dataSetId: mockStorageContext.dataSetId, txHash: '0xtx' },
    })
    opts.onProgress?.({
      type: 'remove-piece:complete',
      data: { txHash: '0xtx', confirmed: true },
    })
    return '0xtx'
  })

  return {
    spinner,
    mockIntro,
    mockOutro,
    mockCancel,
    mockCreateSpinner,
    mockParseCLIAuth,
    mockInitializeSynapse,
    mockCreateStorageContext,
    mockCleanupSynapseService,
    mockRemovePiece,
    mockLogSection,
  }
})

vi.mock('../../utils/cli-helpers.js', () => ({
  intro: mockIntro,
  outro: mockOutro,
  cancel: mockCancel,
  createSpinner: mockCreateSpinner,
}))

vi.mock('../../utils/cli-auth.js', () => ({
  parseCLIAuth: mockParseCLIAuth,
}))

vi.mock('../../utils/cli-logger.js', () => ({
  log: { spinnerSection: mockLogSection },
}))

vi.mock('../../core/synapse/index.js', () => ({
  initializeSynapse: mockInitializeSynapse,
  createStorageContext: mockCreateStorageContext,
  cleanupSynapseService: mockCleanupSynapseService,
}))

vi.mock('../../core/piece/index.js', () => ({
  removePiece: mockRemovePiece,
}))

describe('runRmPiece', () => {
  const baseOptions: RmPieceOptions = {
    piece: 'bafkzcibpiece',
    dataSet: '123',
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('removes a piece and returns result with confirmation status', async () => {
    const result = await runRmPiece({ ...baseOptions, waitForConfirmation: true })

    expect(result).toEqual({
      pieceCid: 'bafkzcibpiece',
      dataSetId: 123,
      transactionHash: '0xtx',
      confirmed: true,
    })

    expect(mockInitializeSynapse).toHaveBeenCalledWith(
      expect.objectContaining({ account: '0xabc', rpcUrl: 'wss://rpc' }),
      expect.anything()
    )
    expect(mockRemovePiece).toHaveBeenCalledWith(
      'bafkzcibpiece',
      expect.objectContaining({ dataSetId: 123 }),
      expect.objectContaining({
        waitForConfirmation: true,
        onProgress: expect.any(Function),
      })
    )
    expect(mockCreateStorageContext).toHaveBeenCalledWith(expect.anything(), {
      logger: expect.anything(),
      dataset: { useExisting: 123n },
    })
    expect(spinner.stop).toHaveBeenCalledWith(expect.stringContaining('Piece removed'))
    expect(mockCleanupSynapseService).toHaveBeenCalled()
    expect(mockIntro).toHaveBeenCalled()
    expect(mockOutro).toHaveBeenCalledWith('Remove completed successfully')
  })

  it('throws when piece CID or data set is missing', async () => {
    await expect(
      runRmPiece({
        ...baseOptions,
        piece: '',
        dataSet: '',
      } as RmPieceOptions)
    ).rejects.toThrow('Piece CID and DataSet ID are required')

    expect(mockRemovePiece).not.toHaveBeenCalled()
    expect(mockCancel).toHaveBeenCalledWith('Remove cancelled')
    expect(spinner.stop).toHaveBeenCalled()
  })

  it('throws on invalid data set id', async () => {
    await expect(runRmPiece({ ...baseOptions, dataSet: '-5' })).rejects.toThrow('DataSet ID must be a positive integer')

    expect(mockRemovePiece).not.toHaveBeenCalled()
    expect(mockCancel).toHaveBeenCalledWith('Remove cancelled')
    expect(spinner.stop).toHaveBeenCalled()
  })
})
