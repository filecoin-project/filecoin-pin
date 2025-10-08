import { METADATA_KEYS, type ProviderInfo, type UploadCallbacks } from '@filoz/synapse-sdk'
import type { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import type { SynapseService } from '../../synapse/service.js'

export interface SynapseUploadOptions {
  /** Optional callbacks for monitoring upload progress. */
  callbacks?: UploadCallbacks
  /** Context identifier for logging (e.g., pinId, import job ID). */
  contextId?: string
}

export interface SynapseUploadResult {
  pieceCid: string
  pieceId?: number | undefined
  dataSetId: string
  providerInfo: ProviderInfo
}

/**
 * Get the direct download URL for a piece from a provider.
 */
export function getDownloadURL(providerInfo: ProviderInfo, pieceCid: string): string {
  const serviceURL = providerInfo.products?.PDP?.data?.serviceURL
  return serviceURL ? `${serviceURL.replace(/\/$/, '')}/piece/${pieceCid}` : ''
}

/**
 * Get the service URL from provider info.
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
 */
export async function uploadToSynapse(
  synapseService: SynapseService,
  carData: Uint8Array,
  rootCid: CID,
  logger: Logger,
  options: SynapseUploadOptions = {}
): Promise<SynapseUploadResult> {
  const { callbacks, contextId = 'upload' } = options

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

  const uploadOptions: any = {
    ...uploadCallbacks,
    metadata: {
      [METADATA_KEYS.IPFS_ROOT_CID]: rootCid.toString(),
    },
  }

  const synapseResult = await synapseService.storage.upload(carData, uploadOptions)

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
