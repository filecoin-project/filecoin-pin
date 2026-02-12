/**
 * Shared Synapse upload functionality
 *
 * This module provides a reusable upload pattern for CAR files to Filecoin
 * via Synapse SDK, used by both the import command and pinning server.
 */
import type { PieceCID, StorageManager } from '@filoz/synapse-sdk'
import { METADATA_KEYS, type ProviderInfo, type UploadCallbacks } from '@filoz/synapse-sdk'
import type { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import type { SynapseService } from '../synapse/index.js'
import type { ProgressEvent, ProgressEventHandler } from '../utils/types.js'

export type UploadProgressEvents =
  | ProgressEvent<'onUploadComplete', { pieceCid: PieceCID }>
  | ProgressEvent<'onPieceAdded', { txHash: `0x${string}` | undefined }>
  | ProgressEvent<'onPieceConfirmed', { pieceIds: number[] }>

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
   * Optional metadata to associate with the upload
   */
  pieceMetadata?: Record<string, string>

  /**
   * Optional AbortSignal to cancel the upload operation.
   */
  signal?: AbortSignal
}

export interface SynapseUploadResult {
  pieceCid: string
  pieceId?: number | undefined
  dataSetId: string
  providerInfo: ProviderInfo
}

/**
 * Get the direct download URL for a piece from a provider
 */
export function getDownloadURL(providerInfo: ProviderInfo, pieceCid: string): string {
  const serviceURL = providerInfo.products?.PDP?.data?.serviceURL
  return serviceURL ? `${serviceURL.replace(/\/$/, '')}/piece/${pieceCid}` : ''
}

/**
 * Get the service URL from provider info
 */
export function getServiceURL(providerInfo: ProviderInfo): string {
  return providerInfo.products?.PDP?.data?.serviceURL ?? ''
}

/**
 * Upload a CAR file to Filecoin via Synapse.
 *
 * This function encapsulates the common upload pattern:
 * 1. Submit CAR data to Synapse storage
 * 2. Track upload progress via callbacks
 * 3. Return piece information
 *
 * @param synapseService - Initialized Synapse service
 * @param carData - CAR file data as Uint8Array
 * @param rootCid - The IPFS root CID to associate with this piece
 * @param logger - Logger instance for tracking
 * @param options - Optional callbacks and context
 * @returns Upload result with piece information
 */
export async function uploadToSynapse(
  synapseService: SynapseService,
  carData: Uint8Array,
  rootCid: CID,
  logger: Logger,
  options: SynapseUploadOptions = {}
): Promise<SynapseUploadResult> {
  // Fail fast if the operation was already aborted before starting
  options.signal?.throwIfAborted()

  const { onProgress, contextId = 'upload' } = options

  // Merge provided callbacks with logging callbacks
  const uploadCallbacks: UploadCallbacks = {
    onUploadComplete: (pieceCid) => {
      logger.info(
        {
          event: 'synapse.upload.piece_uploaded',
          contextId,
          pieceCid: pieceCid.toString(),
        },
        'Upload to PDP server complete'
      )
      onProgress?.({ type: 'onUploadComplete', data: { pieceCid } })
    },

    onPieceAdded: (txHash) => {
      if (txHash != null) {
        logger.info(
          {
            event: 'synapse.upload.piece_added',
            contextId,
            txHash: txHash,
          },
          'Piece addition transaction submitted'
        )
      } else {
        logger.info(
          {
            event: 'synapse.upload.piece_added',
            contextId,
          },
          'Piece added to data set'
        )
      }
      onProgress?.({ type: 'onPieceAdded', data: { txHash } })
    },

    onPieceConfirmed: (pieceIds) => {
      logger.info(
        {
          event: 'synapse.upload.piece_confirmed',
          contextId,
          pieceIds,
        },
        'Piece addition confirmed on-chain'
      )
      onProgress?.({ type: 'onPieceConfirmed', data: { pieceIds } })
    },
  }

  // Upload using Synapse with IPFS root CID metadata
  const uploadOptions: Parameters<StorageManager['upload']>[1] = {
    callbacks: uploadCallbacks,
    metadata: {
      ...(options.pieceMetadata ?? {}),
      [METADATA_KEYS.IPFS_ROOT_CID]: rootCid.toString(), // Associate piece with IPFS root CID
    },
    context: synapseService.storage,
  }

  //  Only include `signal` when defined to satisfy `exactOptionalPropertyTypes`
  if (options.signal != null) {
    uploadOptions.signal = options.signal
  }

  const synapseResult = await synapseService.synapse.storage.upload(carData, uploadOptions)

  // Log success
  logger.info(
    {
      event: 'synapse.upload.success',
      contextId,
      pieceCid: synapseResult.pieceCid,
      pieceId: synapseResult.pieceId,
      dataSetId: synapseService.storage.dataSetId,
    },
    'Successfully uploaded to Filecoin with Synapse'
  )

  const result: SynapseUploadResult = {
    pieceCid: synapseResult.pieceCid.toString(),
    pieceId: synapseResult.pieceId !== undefined ? Number(synapseResult.pieceId) : undefined,
    dataSetId: String(synapseService.storage.dataSetId),
    providerInfo: synapseService.providerInfo,
  }

  return result
}
