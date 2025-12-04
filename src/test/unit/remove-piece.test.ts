import { beforeEach, describe, expect, it, vi } from 'vitest'
import { removePiece } from '../../core/piece/index.js'
import type { RemovePieceOptions } from '../../core/piece/remove-piece.js'

const { mockCreateStorageContext, mockDeletePiece, mockWaitForTransaction, mockSynapse, storageContext, state } =
  vi.hoisted(() => {
    const state = {
      txHash: '0xtest-hash',
      dataSetId: 99,
    }

    const mockDeletePiece = vi.fn(async () => state.txHash)
    const storageContext = {
      dataSetId: state.dataSetId,
      deletePiece: mockDeletePiece,
    }

    const mockWaitForTransaction = vi.fn(async () => undefined)
    const mockSynapse = {
      getProvider: () => ({
        waitForTransaction: mockWaitForTransaction,
      }),
    }

    const mockCreateStorageContext = vi.fn(async (_synapse: any, options: any) => ({
      storage: options?.storage ?? storageContext,
    }))

    return { mockCreateStorageContext, mockDeletePiece, mockWaitForTransaction, mockSynapse, storageContext, state }
  })

vi.mock('../../core/synapse/index.js', () => ({
  createStorageContext: mockCreateStorageContext,
}))

describe('removePiece', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.txHash = '0xtest-hash'
    state.dataSetId = 99
    storageContext.dataSetId = state.dataSetId
  })

  it('creates a storage context when dataSetId is provided', async () => {
    const result = await removePiece('bafkzcibpiece', {
      synapse: mockSynapse as any,
      dataSetId: 42,
    })

    expect(result).toBe(state.txHash)
    expect(mockCreateStorageContext).toHaveBeenCalledWith(mockSynapse, {
      logger: undefined,
      dataset: { useExisting: 42 },
    })
    expect(mockDeletePiece).toHaveBeenCalledWith('bafkzcibpiece')
    expect(mockWaitForTransaction).not.toHaveBeenCalled()
  })

  it('reuses an existing storage context when provided', async () => {
    storageContext.dataSetId = 7

    const result = await removePiece('bafkzcibpiece', {
      synapse: mockSynapse as any,
      storage: storageContext as any,
    })

    expect(result).toBe(state.txHash)
    expect(mockCreateStorageContext).not.toHaveBeenCalled()
    expect(mockDeletePiece).toHaveBeenCalledWith('bafkzcibpiece')
  })

  it('throws when storage context is not bound to a data set', async () => {
    const unboundStorage = { dataSetId: null, deletePiece: vi.fn() }

    await expect(
      removePiece('bafkzcibpiece', {
        synapse: mockSynapse as any,
        storage: unboundStorage as any,
      })
    ).rejects.toThrow(/Storage context must be bound to a Data Set/)
  })

  it('throws when options are invalid', async () => {
    await expect(removePiece('bafkzcibpiece', {} as unknown as RemovePieceOptions)).rejects.toThrow(
      'Invalid options: must provide either dataSetId or storage context'
    )
  })

  it('emits progress events and waits for confirmation when requested', async () => {
    const onProgress = vi.fn()
    mockWaitForTransaction.mockResolvedValueOnce(undefined)

    const result = await removePiece('bafkzcibpiece', {
      synapse: mockSynapse as any,
      storage: storageContext as any,
      waitForConfirmation: true,
      onProgress,
    })

    expect(result).toBe(state.txHash)
    expect(mockWaitForTransaction).toHaveBeenCalledWith(state.txHash, 1, 120000)
    expect(onProgress).toHaveBeenNthCalledWith(1, {
      type: 'remove-piece:submitting',
      data: { pieceCid: 'bafkzcibpiece', dataSetId: 99 },
    })
    expect(onProgress).toHaveBeenNthCalledWith(2, {
      type: 'remove-piece:submitted',
      data: { pieceCid: 'bafkzcibpiece', dataSetId: 99, txHash: state.txHash },
    })
    expect(onProgress).toHaveBeenNthCalledWith(3, {
      type: 'remove-piece:confirming',
      data: { pieceCid: 'bafkzcibpiece', dataSetId: 99, txHash: state.txHash },
    })
    expect(onProgress).toHaveBeenNthCalledWith(4, {
      type: 'remove-piece:complete',
      data: { txHash: state.txHash, confirmed: true },
    })
  })

  it('emits confirmation-failed and still completes when confirmation times out', async () => {
    const onProgress = vi.fn()
    mockWaitForTransaction.mockRejectedValueOnce(new Error('timeout'))

    const result = await removePiece('bafkzcibpiece', {
      synapse: mockSynapse as any,
      storage: storageContext as any,
      waitForConfirmation: true,
      onProgress,
    })

    expect(result).toBe(state.txHash)
    expect(mockWaitForTransaction).toHaveBeenCalledWith(state.txHash, 1, 120000)
    expect(onProgress).toHaveBeenCalledWith({
      type: 'remove-piece:confirmation-failed',
      data: { pieceCid: 'bafkzcibpiece', dataSetId: 99, txHash: state.txHash, message: 'timeout' },
    })
    expect(onProgress).toHaveBeenLastCalledWith({
      type: 'remove-piece:complete',
      data: { txHash: state.txHash, confirmed: false },
    })
  })

  it('skips confirmation when waitForConfirmation is false', async () => {
    const onProgress = vi.fn()

    const result = await removePiece('bafkzcibpiece', {
      synapse: mockSynapse as any,
      storage: storageContext as any,
      onProgress,
    })

    expect(result).toBe(state.txHash)
    expect(mockWaitForTransaction).not.toHaveBeenCalled()
    expect(onProgress).toHaveBeenNthCalledWith(1, {
      type: 'remove-piece:submitting',
      data: { pieceCid: 'bafkzcibpiece', dataSetId: 99 },
    })
    expect(onProgress).toHaveBeenNthCalledWith(2, {
      type: 'remove-piece:submitted',
      data: { pieceCid: 'bafkzcibpiece', dataSetId: 99, txHash: state.txHash },
    })
    expect(onProgress).toHaveBeenNthCalledWith(3, {
      type: 'remove-piece:complete',
      data: { txHash: state.txHash, confirmed: false },
    })
  })
})
