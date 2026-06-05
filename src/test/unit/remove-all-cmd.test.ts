import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runRmAllPieces } from '../../rm/remove-all-pieces.js'
import type { RmAllPiecesOptions } from '../../rm/types.js'

const {
  mockIntro,
  mockOutro,
  mockCancel,
  mockCreateSpinner,
  mockIsInteractive,
  mockParseCLIAuth,
  mockInitializeSynapse,
  mockGetDataSetPieces,
  mockRemoveAllPieces,
  mockConfirm,
  mockIsCancel,
  state,
} = vi.hoisted(() => {
  const spinner = { start: vi.fn(), stop: vi.fn(), message: vi.fn(), clear: vi.fn() }
  const state = {
    pieces: [
      { pieceCid: 'bafkpiece1', status: 'ACTIVE' },
      { pieceCid: 'bafkpiece2', status: 'ACTIVE' },
    ],
  }
  const mockStorageContext = {
    dataSetId: 123n,
    provider: { pdp: { serviceURL: 'https://provider.example.com' } },
  }
  return {
    mockIntro: vi.fn(),
    mockOutro: vi.fn(),
    mockCancel: vi.fn(),
    mockCreateSpinner: vi.fn(() => spinner),
    mockIsInteractive: vi.fn(() => true),
    mockParseCLIAuth: vi.fn(() => ({ privateKey: '0xabc', rpcUrl: 'wss://rpc' })),
    mockInitializeSynapse: vi.fn(() => ({
      chain: { name: 'calibration' },
      storage: { createContext: vi.fn(async () => mockStorageContext) },
    })),
    mockGetDataSetPieces: vi.fn(async () => ({ pieces: state.pieces })),
    mockRemoveAllPieces: vi.fn(),
    mockConfirm: vi.fn(),
    mockIsCancel: vi.fn(() => false),
    state,
  }
})

vi.mock('@clack/prompts', () => ({ confirm: mockConfirm, isCancel: mockIsCancel }))
vi.mock('../../utils/cli-helpers.js', () => ({
  intro: mockIntro,
  outro: mockOutro,
  cancel: mockCancel,
  createSpinner: mockCreateSpinner,
  isInteractive: mockIsInteractive,
}))
vi.mock('../../utils/cli-auth.js', () => ({ parseCLIAuth: mockParseCLIAuth }))
vi.mock('../../utils/cli-logger.js', () => ({
  log: { line: vi.fn(), flush: vi.fn(), spinnerSection: vi.fn() },
}))
vi.mock('../../core/synapse/index.js', () => ({ initializeSynapse: mockInitializeSynapse }))
vi.mock('../../core/piece/index.js', () => ({ removeAllPieces: mockRemoveAllPieces }))
vi.mock('../../core/data-set/get-data-set-pieces.js', () => ({ getDataSetPieces: mockGetDataSetPieces }))
vi.mock('../../core/data-set/types.js', () => ({
  PieceStatus: { ACTIVE: 'ACTIVE', PENDING_REMOVAL: 'PENDING_REMOVAL' },
}))

describe('runRmAllPieces exit codes', () => {
  const baseOptions: RmAllPiecesOptions = { dataSet: '123', all: true }

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsInteractive.mockReturnValue(true)
    mockIsCancel.mockReturnValue(false)
    state.pieces = [
      { pieceCid: 'bafkpiece1', status: 'ACTIVE' },
      { pieceCid: 'bafkpiece2', status: 'ACTIVE' },
    ]
    process.exitCode = 0
  })

  afterEach(() => {
    process.exitCode = 0
  })

  it('exits with code 2 when the user declines the confirmation', async () => {
    mockConfirm.mockResolvedValueOnce(false)

    const result = await runRmAllPieces(baseOptions)

    expect(result.removedCount).toBe(0)
    expect(mockRemoveAllPieces).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(2)
  })

  it('exits with code 2 when a requested confirmation wait times out', async () => {
    mockRemoveAllPieces.mockResolvedValueOnce({
      dataSetId: 123,
      totalPieces: 2,
      removedCount: 2,
      confirmedCount: 1,
      failedCount: 0,
      transactions: [],
    })

    await runRmAllPieces({ ...baseOptions, force: true, waitForConfirmation: true })

    expect(mockRemoveAllPieces).toHaveBeenCalled()
    expect(process.exitCode).toBe(2)
  })

  it('does not set a failure exit code when all confirmations succeed', async () => {
    mockRemoveAllPieces.mockResolvedValueOnce({
      dataSetId: 123,
      totalPieces: 2,
      removedCount: 2,
      confirmedCount: 2,
      failedCount: 0,
      transactions: [],
    })

    await runRmAllPieces({ ...baseOptions, force: true, waitForConfirmation: true })

    expect(process.exitCode).toBe(0)
  })

  it('does not downgrade a prior non-zero exit code on wait timeout', async () => {
    process.exitCode = 1
    mockRemoveAllPieces.mockResolvedValueOnce({
      dataSetId: 123,
      totalPieces: 2,
      removedCount: 2,
      confirmedCount: 1,
      failedCount: 0,
      transactions: [],
    })

    await runRmAllPieces({ ...baseOptions, force: true, waitForConfirmation: true })

    expect(process.exitCode).toBe(1)
  })
})
