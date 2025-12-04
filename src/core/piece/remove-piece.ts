/**
 * Remove piece functionality
 *
 * This module demonstrates the pattern for removing pieces from Data Sets
 * via Synapse SDK. It supports two usage patterns:
 *
 * 1. With dataSetId - creates a temporary storage context (CLI usage)
 * 2. With existing StorageContext - reuses context (library/server usage)
 *
 * Progress events allow callers to track transaction submission and confirmation.
 */
import type { StorageContext, Synapse } from '@filoz/synapse-sdk'
import type { Logger } from 'pino'
import { createStorageContext } from '../synapse/index.js'
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
  /** Initialized Synapse SDK instance */
  synapse: Synapse
  /** Optional progress event handler for tracking removal status */
  onProgress?: ProgressEventHandler<RemovePieceProgressEvents> | undefined
  /** Whether to wait for transaction confirmation before returning (default: false) */
  waitForConfirmation?: boolean | undefined
  /** Optional logger for tracking removal operations */
  logger?: Logger | undefined
}

/**
 * Options for removing a piece when you have a dataSetId
 *
 * This is the typical CLI usage pattern - you know the dataSetId and want
 * to remove a piece from it. A temporary storage context will be created.
 *
 * Note: logger is required in this mode for storage context creation.
 */
interface RemovePieceOptionsWithDataSetId extends RemovePieceOptionsBase {
  /** The Data Set ID containing the piece to remove */
  dataSetId: number
  /** Optional logger for tracking removal operations */
  logger?: Logger | undefined
}

/**
 * Options for removing a piece when you have an existing StorageContext
 *
 * This is useful for library/server usage where you already have a storage
 * context and want to remove multiple pieces without recreating the context.
 */
interface RemovePieceOptionsWithStorage extends RemovePieceOptionsBase {
  /** Existing storage context bound to a Data Set */
  storage: StorageContext
}

/**
 * Options for removing a piece from a Data Set
 *
 * Supports two patterns:
 * - With dataSetId: Creates temporary storage context (CLI pattern)
 * - With storage: Reuses existing context (library/server pattern)
 */
export type RemovePieceOptions = RemovePieceOptionsWithDataSetId | RemovePieceOptionsWithStorage

/**
 * Remove a piece from a Data Set
 *
 * This function demonstrates the pattern for removing pieces via Synapse SDK.
 * It supports two usage patterns:
 *
 * Pattern 1 - With dataSetId (typical CLI usage):
 * ```typescript
 * const txHash = await removePiece('baga...', {
 *   synapse,
 *   dataSetId: 42,
 *   logger,
 *   onProgress: (event) => console.log(event.type),
 *   waitForConfirmation: true
 * })
 * ```
 *
 * Pattern 2 - With existing StorageContext (library/server usage):
 * ```typescript
 * const { storage } = await createStorageContext(synapse, { logger, ... })
 * const txHash = await removePiece('baga...', {
 *   synapse,
 *   storage,
 *   onProgress: (event) => console.log(event.type)
 * })
 * ```
 *
 * @param pieceCid - The Piece CID to remove from the Data Set
 * @param options - Configuration options (dataSetId or storage context)
 * @returns Transaction hash of the removal operation
 * @throws Error if storage context is not bound to a Data Set
 */
export async function removePiece(pieceCid: string, options: RemovePieceOptions): Promise<`0x${string}` | string> {
  // Check dataSetId first
  if (isRemovePieceOptionsWithDataSetId(options)) {
    const { dataSetId, logger, synapse } = options
    const { storage } = await createStorageContext(synapse, { logger, dataset: { useExisting: dataSetId } })
    return executeRemovePiece(pieceCid, dataSetId, storage, options)
  }

  // Handle existing storage context (library/server usage)
  if (isRemovePieceOptionsWithStorage(options)) {
    const dataSetId = options.storage.dataSetId
    if (dataSetId == null) {
      throw new Error(
        'Storage context must be bound to a Data Set before removing pieces. Use createStorageContext with dataset.useExisting to bind to a Data Set.'
      )
    }
    return executeRemovePiece(pieceCid, dataSetId, options.storage, options)
  }

  // Should never get here, but we need some clear error message if we do.
  throw new Error('Invalid options: must provide either dataSetId or storage context')
}

/**
 * Type guard to check if options include dataSetId
 */
function isRemovePieceOptionsWithDataSetId(options: RemovePieceOptions): options is RemovePieceOptionsWithDataSetId {
  return 'dataSetId' in options
}

/**
 * Type guard to check if options include storage context
 */
function isRemovePieceOptionsWithStorage(options: RemovePieceOptions): options is RemovePieceOptionsWithStorage {
  return 'storage' in options && options.storage != null
}

/**
 * Execute the piece removal operation
 *
 * This internal function handles the actual removal:
 * 1. Submits transaction via storageContext.deletePiece()
 * 2. Optionally waits for confirmation if requested
 * 3. Emits progress events throughout the process
 *
 * @param pieceCid - The Piece CID to remove
 * @param dataSetId - The Data Set ID (for progress events)
 * @param storageContext - Storage context bound to the Data Set
 * @param options - Base options including callbacks and confirmation settings
 * @returns Transaction hash of the removal
 */
async function executeRemovePiece(
  pieceCid: string,
  dataSetId: number,
  storageContext: StorageContext,
  options: RemovePieceOptionsBase
): Promise<`0x${string}` | string> {
  const { onProgress, synapse, waitForConfirmation } = options

  onProgress?.({ type: 'remove-piece:submitting', data: { pieceCid, dataSetId } })
  const txHash = await storageContext.deletePiece(pieceCid)
  onProgress?.({ type: 'remove-piece:submitted', data: { pieceCid, dataSetId, txHash } })

  let isConfirmed = false
  if (waitForConfirmation === true) {
    onProgress?.({ type: 'remove-piece:confirming', data: { pieceCid, dataSetId, txHash } })
    try {
      await synapse.getProvider().waitForTransaction(txHash, WAIT_CONFIRMATIONS, WAIT_TIMEOUT_MS)
      isConfirmed = true
    } catch (error: unknown) {
      // Confirmation timeout is non-fatal - transaction may still succeed
      onProgress?.({
        type: 'remove-piece:confirmation-failed',
        data: { pieceCid, dataSetId, txHash, message: getErrorMessage(error) },
      })
    }
  }

  onProgress?.({ type: 'remove-piece:complete', data: { txHash, confirmed: isConfirmed } })
  return txHash
}
