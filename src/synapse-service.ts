import { RPC_URLS, type StorageContext, Synapse, type SynapseOptions, type UploadCallbacks } from '@filoz/synapse-sdk'
import type { Logger } from 'pino'
import type { Config } from './config.js'

let synapseInstance: Synapse | null = null
let storageInstance: StorageContext | null = null

/**
 * Reset the service instances (for testing)
 */
export function resetSynapseService(): void {
  synapseInstance = null
  storageInstance = null
}

export interface SynapseService {
  synapse: Synapse
  storage: StorageContext
}

/**
 * Initialize Synapse SDK and create storage service
 *
 * This function demonstrates the complete initialization flow for Synapse SDK:
 * 1. Validates required configuration (private key)
 * 2. Creates Synapse instance with network configuration
 * 3. Creates a storage context with comprehensive callbacks
 * 4. Returns a service object for application use
 *
 * @param config - Application configuration with privateKey and RPC URL
 * @param logger - Logger instance for detailed operation tracking
 * @returns SynapseService with initialized Synapse and storage context
 */
export async function initializeSynapse(config: Config, logger: Logger): Promise<SynapseService> {
  try {
    // Log the configuration status
    logger.info(
      {
        hasPrivateKey: config.privateKey != null,
        rpcUrl: config.rpcUrl,
      },
      'Initializing Synapse'
    )

    // IMPORTANT: Private key is required for transaction signing
    // In production, this should come from secure environment variables, or a wallet integration
    if (config.privateKey == null) {
      const error = new Error('PRIVATE_KEY environment variable is required for Synapse integration')
      logger.error(
        {
          event: 'synapse.init.failed',
          error: error.message,
        },
        'Synapse initialization failed: missing PRIVATE_KEY'
      )
      throw error
    }
    logger.info({ event: 'synapse.init' }, 'Initializing Synapse SDK')

    // Configure Synapse with network settings
    // Network options: 314 (mainnet) or 314159 (calibration testnet)
    const synapseOptions: SynapseOptions = {
      privateKey: config.privateKey,
      rpcURL: config.rpcUrl ?? RPC_URLS.calibration.websocket, // Default to calibration testnet
    }

    // Optional: Override the default Warm Storage contract address
    // Useful for testing with custom deployments
    if (config.warmStorageAddress != null) {
      synapseOptions.warmStorageAddress = config.warmStorageAddress
    }

    const synapse = await Synapse.create(synapseOptions)

    // Get network info for logging
    const network = synapse.getNetwork()
    logger.info(
      {
        event: 'synapse.init',
        network,
        rpcUrl: synapseOptions.rpcURL,
      },
      'Synapse SDK initialized'
    )

    // Create storage context with comprehensive event tracking
    // The storage context manages the data set and provider interactions
    logger.info({ event: 'synapse.storage.create' }, 'Creating storage context')

    const storage = await synapse.storage.createContext({
      withCDN: false, // CDN not needed for direct CAR file uploads
      // Callbacks provide visibility into the storage lifecycle
      // These are crucial for debugging and monitoring in production
      callbacks: {
        onProviderSelected: (provider) => {
          logger.info(
            {
              event: 'synapse.storage.provider_selected',
              provider: {
                serviceProvider: provider.serviceProvider,
                name: provider.name,
                serviceURL: provider.products?.PDP?.data?.serviceURL,
              },
            },
            'Selected storage provider'
          )
        },
        onDataSetResolved: (info) => {
          logger.info(
            {
              event: 'synapse.storage.data_set_resolved',
              dataSetId: info.dataSetId,
              isExisting: info.isExisting,
            },
            info.isExisting ? 'Using existing data set' : 'Created new data set'
          )
        },
        onDataSetCreationStarted: (transaction, statusUrl) => {
          logger.info(
            {
              event: 'synapse.storage.data_set_creation_started',
              txHash: transaction.hash,
              statusUrl,
            },
            'Data set creation transaction submitted'
          )
        },
        onDataSetCreationProgress: (status) => {
          logger.info(
            {
              event: 'synapse.storage.data_set_creation_progress',
              transactionMined: status.transactionMined,
              dataSetLive: status.dataSetLive,
              elapsedMs: status.elapsedMs,
            },
            'Data set creation progress'
          )
        },
      },
    })

    logger.info(
      {
        event: 'synapse.storage.created',
        dataSetId: storage.dataSetId,
        serviceProvider: storage.serviceProvider,
      },
      'Storage context created successfully'
    )

    // Store instances
    synapseInstance = synapse
    storageInstance = storage

    return { synapse, storage }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error(
      {
        event: 'synapse.init.failed',
        error: errorMessage,
      },
      `Failed to initialize Synapse: ${errorMessage}`
    )
    throw error
  }
}

/**
 * Get the initialized Synapse service
 */
export function getSynapseService(): SynapseService | null {
  if (synapseInstance == null || storageInstance == null) {
    return null
  }
  return {
    synapse: synapseInstance,
    storage: storageInstance,
  }
}

/**
 * Upload data to Filecoin using Synapse
 *
 * This function demonstrates the complete upload flow:
 * 1. Validates service initialization
 * 2. Configures upload callbacks for lifecycle tracking
 * 3. Performs the upload with proper error handling
 * 4. Returns piece information for application tracking
 *
 * The callbacks show all possible upload events that applications
 * can monitor for user feedback and debugging.
 *
 * @param data - Raw bytes to upload (typically a CAR file)
 * @param pinId - Application-specific identifier for tracking
 * @param logger - Logger for operation tracking
 * @returns Object containing pieceCid, pieceId, and dataSetId
 */
export async function uploadToSynapse(
  data: Uint8Array,
  pinId: string,
  logger: Logger
): Promise<{
  pieceCid: string
  pieceId: number
  dataSetId: string
}> {
  const service = getSynapseService()
  if (service == null) {
    throw new Error('Synapse service not initialized')
  }

  logger.info(
    {
      event: 'synapse.upload.start',
      pinId,
      size: data.length,
    },
    'Starting Synapse upload'
  )

  const uploadCallbacks: UploadCallbacks = {
    onUploadComplete: (pieceCid) => {
      logger.info(
        {
          event: 'synapse.upload.piece_uploaded',
          pinId,
          pieceCid: pieceCid.toString(),
        },
        'Upload to PDP server complete'
      )
    },
    onPieceAdded: (transaction) => {
      if (transaction != null) {
        logger.info(
          {
            event: 'synapse.upload.piece_added',
            pinId,
            txHash: transaction.hash,
          },
          'Piece addition transaction submitted'
        )
      } else {
        logger.info(
          {
            event: 'synapse.upload.piece_added',
            pinId,
          },
          'Piece added to data set'
        )
      }
    },
    onPieceConfirmed: (pieceIds) => {
      logger.info(
        {
          event: 'synapse.upload.piece_confirmed',
          pinId,
          pieceIds,
        },
        'Piece addition confirmed on-chain'
      )
    },
  }

  const uploadResult = await service.storage.upload(data, uploadCallbacks)

  logger.info(
    {
      event: 'synapse.upload.complete',
      pinId,
      pieceCid: uploadResult.pieceCid.toString(),
      pieceId: uploadResult.pieceId,
      dataSetId: service.storage.dataSetId,
    },
    'Synapse upload completed successfully'
  )

  return {
    pieceCid: uploadResult.pieceCid.toString(),
    pieceId: uploadResult.pieceId ?? 0,
    dataSetId: String(service.storage.dataSetId),
  }
}
