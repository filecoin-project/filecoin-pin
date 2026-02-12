import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PieceStatus } from '../../core/data-set/types.js'
import { removeAllPieces } from '../../core/piece/index.js'

const { mockGetDataSetPieces, mockRemovePiece, mockStorageContext, state } = vi.hoisted(() => {
  const state = {
    dataSetId: 42,
    pieces: [
      { pieceCid: 'bafkpiece1', status: 'ACTIVE' },
      { pieceCid: 'bafkpiece2', status: 'ACTIVE' },
      { pieceCid: 'bafkpiece3', status: 'PENDING_REMOVAL' },
    ],
    txCounter: 0,
  }

  const mockStorageContext = {
    dataSetId: state.dataSetId,
  }

  const mockGetDataSetPieces = vi.fn(async () => ({
    pieces: state.pieces,
  }))

  const mockRemovePiece = vi.fn(async (_pieceCid: string) => {
    state.txCounter++
    return `0xhash${state.txCounter}`
  })

  return { mockGetDataSetPieces, mockRemovePiece, mockStorageContext, state }
})

vi.mock('../../core/data-set/get-data-set-pieces.js', () => ({
  getDataSetPieces: mockGetDataSetPieces,
}))

vi.mock('../../core/piece/remove-piece.js', () => ({
  removePiece: mockRemovePiece,
}))

describe('removeAllPieces', () => {
  const mockSynapse = { getProvider: vi.fn() }

  beforeEach(() => {
    vi.clearAllMocks()
    state.txCounter = 0
    state.pieces = [
      { pieceCid: 'bafkpiece1', status: PieceStatus.ACTIVE },
      { pieceCid: 'bafkpiece2', status: PieceStatus.ACTIVE },
      { pieceCid: 'bafkpiece3', status: PieceStatus.PENDING_REMOVAL },
    ]
    mockStorageContext.dataSetId = state.dataSetId
  })

  it('removes all active pieces and returns aggregated results', async () => {
    const result = await removeAllPieces(mockStorageContext as any, {
      synapse: mockSynapse as any,
    })

    expect(result.dataSetId).toBe(42)
    expect(result.totalPieces).toBe(2) // Only ACTIVE pieces
    expect(result.removedCount).toBe(2)
    expect(result.failedCount).toBe(0)
    expect(result.transactions).toHaveLength(2)
    expect(mockRemovePiece).toHaveBeenCalledTimes(2)
  })

  it('filters out PENDING_REMOVAL pieces', async () => {
    await removeAllPieces(mockStorageContext as any, {
      synapse: mockSynapse as any,
    })

    // Should only remove ACTIVE pieces, not PENDING_REMOVAL
    expect(mockRemovePiece).toHaveBeenCalledWith('bafkpiece1', expect.anything(), expect.anything())
    expect(mockRemovePiece).toHaveBeenCalledWith('bafkpiece2', expect.anything(), expect.anything())
    expect(mockRemovePiece).not.toHaveBeenCalledWith('bafkpiece3', expect.anything(), expect.anything())
  })

  it('emits progress events in correct order', async () => {
    const onProgress = vi.fn()

    await removeAllPieces(mockStorageContext as any, {
      synapse: mockSynapse as any,
      onProgress,
    })

    const eventTypes = onProgress.mock.calls.map((call) => call[0].type)

    expect(eventTypes).toEqual([
      'remove-all:fetching',
      'remove-all:fetched',
      'remove-all:removing',
      'remove-all:removed',
      'remove-all:removing',
      'remove-all:removed',
      'remove-all:complete',
    ])
  })

  it('tracks success and failure separately', async () => {
    mockRemovePiece.mockResolvedValueOnce('0xsuccess').mockRejectedValueOnce(new Error('Transaction failed'))

    const onProgress = vi.fn()

    const result = await removeAllPieces(mockStorageContext as any, {
      synapse: mockSynapse as any,
      onProgress,
    })

    expect(result.removedCount).toBe(1)
    expect(result.failedCount).toBe(1)
    expect(result.transactions).toEqual([
      { pieceCid: 'bafkpiece1', txHash: '0xsuccess', success: true },
      { pieceCid: 'bafkpiece2', txHash: '', success: false, error: 'Transaction failed' },
    ])

    // Check failed event was emitted
    const failedEvent = onProgress.mock.calls.find((call) => call[0].type === 'remove-all:failed')
    expect(failedEvent).toBeDefined()
    expect(failedEvent?.[0].data.error).toBe('Transaction failed')
  })

  it('returns empty result when no pieces to remove', async () => {
    state.pieces = []

    const result = await removeAllPieces(mockStorageContext as any, {
      synapse: mockSynapse as any,
    })

    expect(result.totalPieces).toBe(0)
    expect(result.removedCount).toBe(0)
    expect(result.failedCount).toBe(0)
    expect(result.transactions).toEqual([])
    expect(mockRemovePiece).not.toHaveBeenCalled()
  })

  it('returns empty result when all pieces are already pending removal', async () => {
    state.pieces = [{ pieceCid: 'bafkpiece1', status: PieceStatus.PENDING_REMOVAL }]

    const result = await removeAllPieces(mockStorageContext as any, {
      synapse: mockSynapse as any,
    })

    expect(result.totalPieces).toBe(0)
    expect(result.removedCount).toBe(0)
    expect(mockRemovePiece).not.toHaveBeenCalled()
  })

  it('throws when storage context is not bound to a data set', async () => {
    const unboundStorage = { dataSetId: null }

    await expect(
      removeAllPieces(unboundStorage as any, {
        synapse: mockSynapse as any,
      })
    ).rejects.toThrow(/Storage context must be bound to a Data Set/)
  })

  it('stops removing pieces when signal is aborted', async () => {
    const controller = new AbortController()

    // Abort after the first piece is removed
    mockRemovePiece.mockImplementation(async () => {
      controller.abort()
      return '0xhash'
    })

    const result = await removeAllPieces(mockStorageContext as any, {
      synapse: mockSynapse as any,
      signal: controller.signal,
    })

    // Should have removed only the first piece before signal check stops the loop
    expect(result.removedCount).toBe(1)
    expect(mockRemovePiece).toHaveBeenCalledTimes(1)
  })

  it('skips internal fetch when pieces are provided', async () => {
    const providedPieces = [
      { pieceId: 1, pieceCid: 'bafkprovided1', status: 'ACTIVE' },
      { pieceId: 2, pieceCid: 'bafkprovided2', status: 'ACTIVE' },
    ]

    const result = await removeAllPieces(mockStorageContext as any, {
      synapse: mockSynapse as any,
      pieces: providedPieces as any,
    })

    // getDataSetPieces should NOT be called
    expect(mockGetDataSetPieces).not.toHaveBeenCalled()
    expect(result.totalPieces).toBe(2)
    expect(result.removedCount).toBe(2)
    expect(mockRemovePiece).toHaveBeenCalledWith('bafkprovided1', expect.anything(), expect.anything())
    expect(mockRemovePiece).toHaveBeenCalledWith('bafkprovided2', expect.anything(), expect.anything())
  })

  it('filters provided pieces to only remove ACTIVE ones', async () => {
    const providedPieces = [
      { pieceId: 1, pieceCid: 'bafkactive', status: 'ACTIVE' },
      { pieceId: 2, pieceCid: 'bafkpending', status: 'PENDING_REMOVAL' },
    ]

    const result = await removeAllPieces(mockStorageContext as any, {
      synapse: mockSynapse as any,
      pieces: providedPieces as any,
    })

    expect(mockGetDataSetPieces).not.toHaveBeenCalled()
    expect(result.totalPieces).toBe(1)
    expect(result.removedCount).toBe(1)
    expect(mockRemovePiece).toHaveBeenCalledWith('bafkactive', expect.anything(), expect.anything())
    expect(mockRemovePiece).not.toHaveBeenCalledWith('bafkpending', expect.anything(), expect.anything())
  })
})
