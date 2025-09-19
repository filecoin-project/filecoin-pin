import {
  METADATA_KEYS,
  type ProviderInfo,
  RPC_URLS,
  type StorageContext,
  Synapse,
  type SynapseOptions,
} from '@filoz/synapse-sdk'
import type { Logger } from 'pino'
import type { Config } from '../config.js'

/**
 * Default metadata for Synapse data sets created by filecoin-pin
 */
const DEFAULT_DATA_SET_METADATA = {
  [METADATA_KEYS.WITH_IPFS_INDEXING]: '', // Enable IPFS indexing for all data sets
  source: 'filecoin-pin', // Identify the source application
} as const

/**
 * Default configuration for creating storage contexts
 */
const DEFAULT_STORAGE_CONTEXT_CONFIG = {
  withCDN: false, // CDN not needed for Filecoin Pin currently
  metadata: DEFAULT_DATA_SET_METADATA,
} as const

let synapseInstance: Synapse | null = null
let storageInstance: StorageContext | null = null
let currentProviderInfo: ProviderInfo | null = null
let activeProvider: any = null // Track the provider for cleanup

/**
 * Reset the service instances (for testing)
 */
export function resetSynapseService(): void {
  synapseInstance = null
  storageInstance = null
  currentProviderInfo = null
  activeProvider = null
}

export interface SynapseService {
  synapse: Synapse
  storage: StorageContext
  providerInfo?: ProviderInfo | undefined
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
export async function initializeSynapse(
  config: Config,
  logger: Logger,
  progressCallbacks?: {
    onProviderSelected?: (provider: any) => void
    onDataSetCreationStarted?: (transaction: any) => void
    onDataSetResolved?: (info: { dataSetId: number; isExisting: boolean }) => void
  }
): Promise<SynapseService> {
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

    // Store reference to the provider for cleanup if it's a WebSocket provider
    if (synapseOptions.rpcURL && /^ws(s)?:\/\//i.test(synapseOptions.rpcURL)) {
      activeProvider = synapse.getProvider()
    }

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
      ...DEFAULT_STORAGE_CONTEXT_CONFIG,
      // Callbacks provide visibility into the storage lifecycle
      // These are crucial for debugging and monitoring in production
      callbacks: {
        onProviderSelected: (provider) => {
          // Store the provider info for later use
          currentProviderInfo = provider

          logger.info(
            {
              event: 'synapse.storage.provider_selected',
              provider: {
                id: provider.id,
                serviceProvider: provider.serviceProvider,
                name: provider.name,
                serviceURL: provider.products?.PDP?.data?.serviceURL,
              },
            },
            'Selected storage provider'
          )

          // Call progress callback if provided
          if (progressCallbacks?.onProviderSelected) {
            progressCallbacks.onProviderSelected(provider)
          }
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

          // Call progress callback if provided
          if (progressCallbacks?.onDataSetResolved) {
            progressCallbacks.onDataSetResolved(info)
          }
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

          // Call progress callback if provided
          if (progressCallbacks?.onDataSetCreationStarted) {
            progressCallbacks.onDataSetCreationStarted(transaction)
          }
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

    return { synapse, storage, providerInfo: currentProviderInfo ?? undefined }
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
 * Get default storage context configuration for consistent data set creation
 *
 * @param overrides - Optional overrides to merge with defaults
 * @returns Storage context configuration with defaults
 */
export function getDefaultStorageContextConfig(overrides: any = {}) {
  return {
    ...DEFAULT_STORAGE_CONTEXT_CONFIG,
    ...overrides,
    metadata: {
      ...DEFAULT_DATA_SET_METADATA,
      ...overrides.metadata,
    },
  }
}

/**
 * Clean up WebSocket providers and other resources
 *
 * Call this when CLI commands are finishing to ensure proper cleanup
 * and allow the process to terminate.
 */
export async function cleanupSynapseService(): Promise<void> {
  if (activeProvider && typeof activeProvider.destroy === 'function') {
    try {
      await activeProvider.destroy()
    } catch {
      // Ignore cleanup errors
    }
  }

  // Clear references
  synapseInstance = null
  storageInstance = null
  currentProviderInfo = null
  activeProvider = null
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
    providerInfo: currentProviderInfo ?? undefined,
  }
}
