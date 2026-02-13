import type { Synapse } from '@filoz/synapse-sdk'
import type { StorageContext } from '@filoz/synapse-sdk/storage'
import type { Logger } from 'pino'
import type { Hex } from 'viem'
import { waitForTransactionReceipt } from 'viem/actions'
import { getErrorMessage } from '../utils/errors.js'
import type { ProgressEvent, ProgressEventHandler } from '../utils/types.js'

/**
 * Progress events emitted during piece removal
 *
 * These events allow callers to track the removal process:
 * - submitting: Transaction is being submitted to blockchain
 * - submitted: Transaction submitted successfully, txHash available
 * - confirming: Waiting for transaction confirmation (if waitForConfirmation=true)
 * - confirmation-failed: Confirmation wait timed out (non-fatal, tx may still succeed)
 * - complete: Removal process finished
 *
 * Note: Errors are propagated via thrown exceptions, not events (similar to upload pattern)
 */
export type RemovePieceProgressEvents =
  | ProgressEvent<'remove-piece:submitting', { pieceCid: string; dataSetId: number }>
  | ProgressEvent<'remove-piece:submitted', { pieceCid: string; dataSetId: number; txHash: `0x${string}` | string }>
  | ProgressEvent<'remove-piece:confirming', { pieceCid: string; dataSetId: number; txHash: `0x${string}` | string }>
  | ProgressEvent<
      'remove-piece:confirmation-failed',
      { pieceCid: string; dataSetId: number; txHash: `0x${string}` | string; message: string }
    >
  | ProgressEvent<'remove-piece:complete', { txHash: `0x${string}` | string; confirmed: boolean }>

/**
 * Number of block confirmations to wait for when waitForConfirmation=true
 */
const WAIT_CONFIRMATIONS = 1

/**
 * Timeout in milliseconds for waiting for transaction confirmation
 * Set to 2 minutes - generous default for Calibration network finality
 */
const WAIT_TIMEOUT_MS = 2 * 60 * 1000

/**
 * Base options for piece removal
 */
interface RemovePieceOptionsBase {
  /** Initialized Synapse SDK instance (required when waitForConfirmation is true)*/
  synapse?: Synapse | undefined
  /** Optional progress event handler for tracking removal status */
  onProgress?: ProgressEventHandler<RemovePieceProgressEvents> | undefined
  /** Whether to wait for transaction confirmation before returning (default: false) */
  waitForConfirmation?: boolean | undefined
  /** Optional logger for tracking removal operations */
  logger?: Logger | undefined
}

interface RemovePieceOptionsWithWaitForConfirmation extends RemovePieceOptionsBase {
  waitForConfirmation: true
  synapse: Synapse
}

export type RemovePieceOptions = RemovePieceOptionsBase | RemovePieceOptionsWithWaitForConfirmation

/**
 * Remove a piece from a Data Set
 *
 * @example
 * ```typescript
 * const txHash = await removePiece('baga...', storageContext, {
 *   synapse,
 *   onProgress: (event) => console.log(event.type),
 *   waitForConfirmation: true
 * })
 * ```
 *
 * Process:
 * 1. Submit the transaction via storageContext.deletePiece
 * 2. Optionally wait for confirmation using Synapse provider
 * 3. Emit progress events for each stage
 *
 * @param pieceCid - Piece CID to remove
 * @param storageContext - Storage context bound to a Data Set
 * @param options - Callbacks and confirmation settings (synapse required if waiting)
 * @returns Transaction hash of the removal
 */
export async function removePiece(
  pieceCid: string,
  storageContext: StorageContext,
  options: RemovePieceOptions
): Promise<`0x${string}` | string> {
  const { onProgress, waitForConfirmation } = options
  const dataSetId = storageContext.dataSetId

  if (dataSetId == null) {
    throw new Error(
      'Storage context must be bound to a Data Set before removing pieces. Use createStorageContext with dataset.useExisting to bind to a Data Set.'
    )
  }
  if (waitForConfirmation === true && !isWaitForConfirmationOptions(options)) {
    throw new Error('A Synapse instance is required when waitForConfirmation is true')
  }

  onProgress?.({ type: 'remove-piece:submitting', data: { pieceCid, dataSetId: Number(dataSetId) } })
  const txHash = await storageContext.deletePiece({ piece: pieceCid })
  onProgress?.({ type: 'remove-piece:submitted', data: { pieceCid, dataSetId: Number(dataSetId), txHash } })

  let isConfirmed = false
  if (isWaitForConfirmationOptions(options)) {
    const { synapse } = options
    onProgress?.({ type: 'remove-piece:confirming', data: { pieceCid, dataSetId: Number(dataSetId), txHash } })
    try {
      await waitForTransactionReceipt(synapse.client, {
        hash: txHash as Hex,
        confirmations: WAIT_CONFIRMATIONS,
        timeout: WAIT_TIMEOUT_MS,
      })
      isConfirmed = true
    } catch (error: unknown) {
      // Confirmation timeout is non-fatal - transaction may still succeed
      onProgress?.({
        type: 'remove-piece:confirmation-failed',
        data: { pieceCid, dataSetId: Number(dataSetId), txHash, message: getErrorMessage(error) },
      })
    }
  }

  onProgress?.({ type: 'remove-piece:complete', data: { txHash, confirmed: isConfirmed } })
  return txHash
}

function isWaitForConfirmationOptions(
  options: RemovePieceOptions
): options is RemovePieceOptionsWithWaitForConfirmation {
  return options.waitForConfirmation === true && options.synapse != null
}
