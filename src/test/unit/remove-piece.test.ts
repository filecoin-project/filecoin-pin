import { beforeEach, describe, expect, it, vi } from 'vitest'
import { removePiece } from '../../core/piece/index.js'

const { mockDeletePiece, mockWaitForTransactionReceipt, mockSynapse, storageContext, state } = vi.hoisted(() => {
  const state = {
    txHash: '0xtest-hash' as `0x${string}`,
    dataSetId: 99n,
  }

  const mockDeletePiece = vi.fn(async () => state.txHash)
  const storageContext = {
    dataSetId: state.dataSetId,
    deletePiece: mockDeletePiece,
  }

  const mockWaitForTransactionReceipt = vi.fn(async () => undefined)
  const mockSynapse = {
    client: {
      waitForTransactionReceipt: mockWaitForTransactionReceipt,
    },
  }

  return { mockDeletePiece, mockWaitForTransactionReceipt, mockSynapse, storageContext, state }
})

describe('removePiece', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.txHash = '0xtest-hash'
    state.dataSetId = 99n
    storageContext.dataSetId = state.dataSetId
  })

  it('removes a piece without waiting for confirmation', async () => {
    const result = await removePiece('bafkzcibpiece', storageContext as any, {})

    expect(result).toBe(state.txHash)
    expect(mockDeletePiece).toHaveBeenCalledWith({ piece: 'bafkzcibpiece' })
    expect(mockWaitForTransactionReceipt).not.toHaveBeenCalled()
  })

  it('throws when storage context is not bound to a data set', async () => {
    const unboundStorage = { dataSetId: null, deletePiece: vi.fn() }

    await expect(removePiece('bafkzcibpiece', unboundStorage as any, {})).rejects.toThrow(
      /Storage context must be bound to a Data Set/
    )
  })

  it('emits progress events and waits for confirmation when requested', async () => {
    const onProgress = vi.fn()
    mockWaitForTransactionReceipt.mockResolvedValueOnce(undefined)

    const result = await removePiece('bafkzcibpiece', storageContext as any, {
      synapse: mockSynapse as any,
      waitForConfirmation: true,
      onProgress,
    })

    expect(result).toBe(state.txHash)
    expect(mockWaitForTransactionReceipt).toHaveBeenCalledWith({
      hash: state.txHash,
      confirmations: 1,
      timeout: 120000,
    })
    expect(onProgress).toHaveBeenNthCalledWith(1, {
      type: 'remove-piece:submitting',
      data: { pieceCid: 'bafkzcibpiece', dataSetId: 99n },
    })
    expect(onProgress).toHaveBeenNthCalledWith(2, {
      type: 'remove-piece:submitted',
      data: { pieceCid: 'bafkzcibpiece', dataSetId: 99n, txHash: state.txHash },
    })
    expect(onProgress).toHaveBeenNthCalledWith(3, {
      type: 'remove-piece:confirming',
      data: { pieceCid: 'bafkzcibpiece', dataSetId: 99n, txHash: state.txHash },
    })
    expect(onProgress).toHaveBeenNthCalledWith(4, {
      type: 'remove-piece:complete',
      data: { txHash: state.txHash, confirmed: true },
    })
  })

  it('emits confirmation-failed and still completes when confirmation times out', async () => {
    const onProgress = vi.fn()
    mockWaitForTransactionReceipt.mockRejectedValueOnce(new Error('timeout'))

    const result = await removePiece('bafkzcibpiece', storageContext as any, {
      synapse: mockSynapse as any,
      waitForConfirmation: true,
      onProgress,
    })

    expect(result).toBe(state.txHash)
    expect(mockWaitForTransactionReceipt).toHaveBeenCalledWith({
      hash: state.txHash,
      confirmations: 1,
      timeout: 120000,
    })
    expect(onProgress).toHaveBeenCalledWith({
      type: 'remove-piece:confirmation-failed',
      data: { pieceCid: 'bafkzcibpiece', dataSetId: 99n, txHash: state.txHash, message: 'timeout' },
    })
    expect(onProgress).toHaveBeenLastCalledWith({
      type: 'remove-piece:complete',
      data: { txHash: state.txHash, confirmed: false },
    })
  })

  it('skips confirmation when waitForConfirmation is false', async () => {
    const onProgress = vi.fn()

    const result = await removePiece('bafkzcibpiece', storageContext as any, { onProgress })

    expect(result).toBe(state.txHash)
    expect(mockWaitForTransactionReceipt).not.toHaveBeenCalled()
    expect(onProgress).toHaveBeenNthCalledWith(1, {
      type: 'remove-piece:submitting',
      data: { pieceCid: 'bafkzcibpiece', dataSetId: 99n },
    })
    expect(onProgress).toHaveBeenNthCalledWith(2, {
      type: 'remove-piece:submitted',
      data: { pieceCid: 'bafkzcibpiece', dataSetId: 99n, txHash: state.txHash },
    })
    expect(onProgress).toHaveBeenNthCalledWith(3, {
      type: 'remove-piece:complete',
      data: { txHash: state.txHash, confirmed: false },
    })
  })

  it('throws when waiting for confirmation without a synapse instance', async () => {
    await expect(
      removePiece('bafkzcibpiece', storageContext as any, {
        waitForConfirmation: true,
      })
    ).rejects.toThrow('A Synapse instance is required when waitForConfirmation is true')
  })
})
