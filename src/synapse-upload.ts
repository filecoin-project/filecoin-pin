/**
 * Shared Synapse upload functionality
 *
 * This module provides a reusable upload pattern for CAR files to Filecoin
 * via Synapse SDK, used by both the import command and pinning server.
 */

import { METADATA_KEYS, type UploadCallbacks } from '@filoz/synapse-sdk'
import type { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import type { SynapseService } from './synapse-service.js'

export interface SynapseUploadOptions {
  /**
   * Optional callbacks for monitoring upload progress
   */
  callbacks?: UploadCallbacks

  /**
   * Context identifier for logging (e.g., pinId, import job ID)
   */
  contextId?: string
}

export interface SynapseUploadResult {
  pieceCid: string
  pieceId?: number | undefined
  dataSetId: string
  providerInfo?:
    | {
        id: number
        name: string
        serviceURL: string
        downloadURL: string
      }
    | undefined
}

/**
 * Upload a CAR file to Filecoin via Synapse
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
  const { callbacks, contextId = 'upload' } = options

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
      callbacks?.onUploadComplete?.(pieceCid)
    },

    onPieceAdded: (transaction) => {
      if (transaction != null) {
        logger.info(
          {
            event: 'synapse.upload.piece_added',
            contextId,
            txHash: transaction.hash,
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
      callbacks?.onPieceAdded?.(transaction)
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
      callbacks?.onPieceConfirmed?.(pieceIds)
    },
  }

  // Upload using Synapse with IPFS root CID metadata
  const uploadOptions: any = {
    ...uploadCallbacks,
    metadata: {
      [METADATA_KEYS.IPFS_ROOT_CID]: rootCid.toString(), // Associate piece with IPFS root CID
    },
  }

  const synapseResult = await synapseService.storage.upload(carData, uploadOptions)

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
  }

  // Add provider info if available
  if (synapseService.providerInfo) {
    const serviceURL = synapseService.providerInfo.products?.PDP?.data?.serviceURL
    if (serviceURL) {
      result.providerInfo = {
        id: synapseService.providerInfo.id,
        name: synapseService.providerInfo.name,
        serviceURL,
        downloadURL: `${serviceURL.replace(/\/$/, '')}/piece/${result.pieceCid}`,
      }
    }
  }

  return result
}
