/**
 * Shared Synapse upload functionality
 *
 * Provides a reusable upload pattern for CAR data to Filecoin via Synapse SDK,
 * used by both CLI commands and the pinning server. Uses the StorageManager for
 * provider selection and multi-copy orchestration.
 */
import type { CopyResult, FailedAttempt, PieceCID, PullStatus, Synapse, UploadResult } from '@filoz/synapse-sdk'
import { METADATA_KEYS, type PDPProvider } from '@filoz/synapse-sdk'
import type { StorageManagerUploadOptions } from '@filoz/synapse-sdk/storage'
import type { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import type { Hash } from 'viem'
import { DEFAULT_DATA_SET_METADATA } from '../synapse/constants.js'
import type { ProgressEvent, ProgressEventHandler } from '../utils/types.js'

export type UploadProgressEvents =
  | ProgressEvent<'onStored', { providerId: bigint; pieceCid: PieceCID }>
  | ProgressEvent<'onPiecesAdded', { txHash: Hash; providerId: bigint }>
  | ProgressEvent<'onPiecesConfirmed', { dataSetId: bigint; providerId: bigint; pieceIds: bigint[] }>
  | ProgressEvent<'onCopyComplete', { providerId: bigint; pieceCid: PieceCID }>
  | ProgressEvent<'onCopyFailed', { providerId: bigint; pieceCid: PieceCID; error: Error }>
  | ProgressEvent<'onPullProgress', { providerId: bigint; pieceCid: PieceCID; status: PullStatus }>
  | ProgressEvent<'onProviderSelected', { provider: PDPProvider }>
  | ProgressEvent<'onDataSetResolved', { dataSetId: bigint; provider: PDPProvider }>

export interface SynapseUploadOptions {
  /**
   * Optional callbacks for monitoring upload progress
   */
  onProgress?: ProgressEventHandler<UploadProgressEvents>

  /**
   * Context identifier for logging (e.g., pinId, import job ID)
   */
  contextId?: string

  /**
   * Optional metadata to associate with the upload (per-piece)
   */
  pieceMetadata?: Record<string, string>

  /**
   * Optional AbortSignal to cancel the upload operation.
   */
  signal?: AbortSignal

  /**
   * Number of storage copies to create (default determined by SDK).
   */
  copies?: number

  /**
   * Specific provider IDs to use (mutually exclusive with dataSetIds).
   */
  providerIds?: bigint[]

  /**
   * Specific data set IDs to use (mutually exclusive with providerIds).
   */
  dataSetIds?: bigint[]

  /**
   * Provider IDs to exclude from selection.
   */
  excludeProviderIds?: bigint[]

  /**
   * Data set metadata applied when creating or matching contexts.
   */
  metadata?: Record<string, string>
}

export interface SynapseUploadResult {
  pieceCid: string
  size: number
  copies: CopyResult[]
  failedAttempts: FailedAttempt[]
}

/**
 * Get the direct download URL for a piece from a provider
 */
export function getDownloadURL(providerInfo: PDPProvider, pieceCid: string): string {
  const serviceURL = providerInfo.pdp?.serviceURL
  return serviceURL ? `${serviceURL.replace(/\/$/, '')}/piece/${pieceCid}` : ''
}

/**
 * Get the service URL from provider info
 */
export function getServiceURL(providerInfo: PDPProvider): string {
  return providerInfo.pdp?.serviceURL ?? ''
}

/**
 * Upload a CAR to Filecoin via Synapse.
 *
 * Uses the StorageManager for multi-copy orchestration. The SDK handles
 * provider selection, data set creation, and SP-to-SP pull for secondary
 * copies.
 *
 * @param synapse - Initialized Synapse instance
 * @param carData - CAR data as Uint8Array
 * @param rootCid - The IPFS root CID to associate with this piece
 * @param logger - Logger instance for tracking
 * @param options - Upload options including context selection and callbacks
 * @returns Upload result including piece CID, size, copies, and failed attempts
 */
export async function uploadToSynapse(
  synapse: Synapse,
  carData: Uint8Array,
  rootCid: CID,
  logger: Logger,
  options: SynapseUploadOptions = {}
): Promise<SynapseUploadResult> {
  options.signal?.throwIfAborted()

  const { onProgress, contextId = 'upload' } = options

  const uploadOptions: StorageManagerUploadOptions = {
    pieceMetadata: {
      ...(options.pieceMetadata ?? {}),
      [METADATA_KEYS.IPFS_ROOT_CID]: rootCid.toString(),
    },

    callbacks: {
      onProviderSelected: (provider) => {
        logger.info(
          {
            event: 'synapse.upload.provider_selected',
            contextId,
            providerId: String(provider.id),
            providerName: provider.name,
          },
          'Provider selected'
        )
        onProgress?.({ type: 'onProviderSelected', data: { provider } })
      },

      onDataSetResolved: (info) => {
        logger.info(
          {
            event: 'synapse.upload.dataset_resolved',
            contextId,
            dataSetId: String(info.dataSetId),
            providerId: String(info.provider.id),
          },
          'Data set resolved'
        )
        onProgress?.({ type: 'onDataSetResolved', data: { dataSetId: info.dataSetId, provider: info.provider } })
      },

      onStored: (providerId, pieceCid) => {
        logger.info(
          {
            event: 'synapse.upload.stored',
            contextId,
            providerId: String(providerId),
            pieceCid: pieceCid.toString(),
          },
          'Piece stored on provider'
        )
        onProgress?.({ type: 'onStored', data: { providerId, pieceCid } })
      },

      onPiecesAdded: (txHash, providerId, pieces) => {
        logger.info(
          {
            event: 'synapse.upload.pieces_added',
            contextId,
            txHash,
            providerId: String(providerId),
            pieceCount: pieces.length,
          },
          'Piece addition transaction submitted'
        )
        onProgress?.({ type: 'onPiecesAdded', data: { txHash, providerId } })
      },

      onPiecesConfirmed: (dataSetId, providerId, pieces) => {
        const pieceIds = pieces.map((p) => p.pieceId)
        logger.info(
          {
            event: 'synapse.upload.pieces_confirmed',
            contextId,
            dataSetId: String(dataSetId),
            providerId: String(providerId),
            pieceIds: pieceIds.map(String),
          },
          'Piece addition confirmed on-chain'
        )
        onProgress?.({ type: 'onPiecesConfirmed', data: { dataSetId, providerId, pieceIds } })
      },

      onCopyComplete: (providerId, pieceCid) => {
        logger.info(
          {
            event: 'synapse.upload.copy_complete',
            contextId,
            providerId: String(providerId),
            pieceCid: pieceCid.toString(),
          },
          'Secondary copy complete'
        )
        onProgress?.({ type: 'onCopyComplete', data: { providerId, pieceCid } })
      },

      onCopyFailed: (providerId, pieceCid, error) => {
        logger.warn(
          {
            event: 'synapse.upload.copy_failed',
            contextId,
            providerId: String(providerId),
            pieceCid: pieceCid.toString(),
            error: error.message,
          },
          'Secondary copy failed'
        )
        onProgress?.({ type: 'onCopyFailed', data: { providerId, pieceCid, error } })
      },

      onPullProgress: (providerId, pieceCid, status) => {
        logger.debug(
          {
            event: 'synapse.upload.pull_progress',
            contextId,
            providerId: String(providerId),
            pieceCid: pieceCid.toString(),
            status,
          },
          'Pull progress update'
        )
        onProgress?.({ type: 'onPullProgress', data: { providerId, pieceCid, status } })
      },
    },
  }

  // Always include default data set metadata (withIPFSIndexing, source).
  // User-supplied metadata can extend but not remove these defaults.
  uploadOptions.metadata = {
    ...DEFAULT_DATA_SET_METADATA,
    ...(options.metadata ?? {}),
  }

  // Pass through context selection options
  if (options.copies != null) {
    uploadOptions.copies = options.copies
  }
  if (options.providerIds != null) {
    uploadOptions.providerIds = options.providerIds
  }
  if (options.dataSetIds != null) {
    uploadOptions.dataSetIds = options.dataSetIds
  }
  if (options.excludeProviderIds != null) {
    uploadOptions.excludeProviderIds = options.excludeProviderIds
  }
  if (options.signal != null) {
    uploadOptions.signal = options.signal
  }

  const synapseResult: UploadResult = await synapse.storage.upload(carData, uploadOptions)

  logger.info(
    {
      event: 'synapse.upload.success',
      contextId,
      pieceCid: synapseResult.pieceCid.toString(),
      size: synapseResult.size,
      copies: synapseResult.copies.length,
      failedAttempts: synapseResult.failedAttempts.length,
    },
    'Successfully uploaded to Filecoin with Synapse'
  )

  return {
    pieceCid: synapseResult.pieceCid.toString(),
    size: synapseResult.size,
    copies: synapseResult.copies,
    failedAttempts: synapseResult.failedAttempts,
  }
}
