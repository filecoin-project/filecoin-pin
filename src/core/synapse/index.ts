import {
  METADATA_KEYS,
  type ProviderInfo,
  RPC_URLS,
  type StorageContext,
  type StorageCreationCallbacks,
  type StorageServiceOptions,
  Synapse,
  type SynapseOptions,
} from '@filoz/synapse-sdk'
import type { Logger } from 'pino'

const WEBSOCKET_REGEX = /^ws(s)?:\/\//i

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
 * Complete application configuration interface
 * This is the main config interface that can be imported by CLI and other consumers
 */
export interface Config {
  port: number
  host: string
  privateKey: string | undefined
  rpcUrl: string
  databasePath: string
  // TODO: remove this from core?
  carStoragePath: string
  logLevel: string
  warmStorageAddress: string | undefined
}

/**
 * Configuration for Synapse initialization
 * Extends the main Config but makes privateKey required and rpcUrl optional
 */
export interface SynapseSetupConfig extends Partial<Omit<Config, 'privateKey' | 'rpcUrl'>> {
  /** Private key used for signing transactions. */
  privateKey: string
  /** RPC endpoint for the target Filecoin network. Defaults to calibration. */
  rpcUrl?: string | undefined
}

/**
 * Structured service object containing the fully initialized Synapse SDK and
 * its storage context
 */
export interface SynapseService {
  synapse: Synapse
  storage: StorageContext
  providerInfo: ProviderInfo
}

/**
 * Dataset selection options for multi-tenant scenarios.
 *
 * This is a curated subset of Synapse SDK options focused on the common
 * use cases for filecoin-pin.
 */
export interface DatasetOptions {
  /**
   * Create a new dataset even if one exists for this wallet.
   *
   * Set to `true` when you want each user to have their own dataset
   * despite sharing the same wallet (e.g., multi-tenant websites and org/enterprise services using the same wallet).
   *
   * @default false
   */
  createNew?: boolean

  /**
   * Connect to a specific dataset by ID.
   *
   * Use this to reconnect to a user's existing dataset after retrieving
   * the ID from localStorage or a database.
   *
   * Takes precedence over `createNew` if both are provided.
   */
  useExisting?: number

  /**
   * Custom metadata to attach to the dataset.
   *
   * Note: If `useExisting` is provided, metadata is ignored since you're
   * connecting to an existing dataset.
   */
  metadata?: Record<string, string>
}

/**
 * Progress callbacks for tracking dataset and provider selection.
 */
export type StorageProgressCallbacks = Omit<StorageCreationCallbacks, 'onDataSetCreationProgress'>

/**
 * Options for creating a storage context.
 */
export interface CreateStorageContextOptions {
  /**
   * Dataset selection options.
   */
  dataset?: DatasetOptions

  /**
   * Progress callbacks for tracking creation.
   */
  callbacks?: StorageProgressCallbacks
}

/**
 * Reset the service instances (for testing)
 */
export function resetSynapseService(): void {
  synapseInstance = null
  storageInstance = null
  currentProviderInfo = null
  activeProvider = null
}

/**
 * Initialize the Synapse SDK without creating storage context
 *
 * This function initializes the Synapse SDK connection without creating
 * a storage context. This method is primarily a wrapper for handling our
 * custom configuration needs and adding detailed logging.
 *
 * @param config - Application configuration with privateKey and RPC URL
 * @param logger - Logger instance for detailed operation tracking
 * @returns Initialized Synapse instance
 */
export async function initializeSynapse(config: SynapseSetupConfig, logger: Logger): Promise<Synapse> {
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
    const privateKey = config.privateKey
    if (privateKey == null) {
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
      privateKey,
      rpcURL: config.rpcUrl ?? RPC_URLS.calibration.websocket, // Default to calibration testnet
    }

    // Optional: Override the default Warm Storage contract address
    // Useful for testing with custom deployments
    if (config.warmStorageAddress != null) {
      synapseOptions.warmStorageAddress = config.warmStorageAddress
    }

    const synapse = await Synapse.create(synapseOptions)

    // Store reference to the provider for cleanup if it's a WebSocket provider
    if (synapseOptions.rpcURL && WEBSOCKET_REGEX.test(synapseOptions.rpcURL)) {
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

    // Store instance for cleanup
    synapseInstance = synapse

    return synapse
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error(
      {
        event: 'synapse.init.failed',
        error: errorMessage,
      },
      `Failed to initialize Synapse SDK: ${errorMessage}`
    )
    throw error
  }
}

/**
 * Create storage context for an initialized Synapse instance
 *
 * This creates a storage context with comprehensive callbacks for tracking
 * the data set creation and provider selection process. This is primarily
 * a wrapper around the Synapse SDK's storage context creation, adding logging
 * and progress callbacks for better observability.
 *
 * @param synapse - Initialized Synapse instance
 * @param logger - Logger instance for detailed operation tracking
 * @param options - Optional configuration for dataset selection and callbacks
 * @returns Storage context and provider information
 *
 * @example
 * ```typescript
 * // Create a new dataset (multi-user scenario)
 * const { storage } = await createStorageContext(synapse, logger, {
 *   dataset: { createNew: true }
 * })
 *
 * // Connect to existing dataset
 * const { storage } = await createStorageContext(synapse, logger, {
 *   dataset: { useExisting: 123 }
 * })
 *
 * // Default behavior (reuse wallet's dataset)
 * const { storage } = await createStorageContext(synapse, logger)
 * ```
 */
export async function createStorageContext(
  synapse: Synapse,
  logger: Logger,
  options?: CreateStorageContextOptions
): Promise<{ storage: StorageContext; providerInfo: ProviderInfo }> {
  try {
    // Create storage context with comprehensive event tracking
    // The storage context manages the data set and provider interactions
    logger.info({ event: 'synapse.storage.create' }, 'Creating storage context')

    // Optional override: allow selecting a specific provider via env vars
    const envProviderAddress = process.env.PROVIDER_ADDRESS?.trim()
    const envProviderIdRaw = process.env.PROVIDER_ID?.trim()
    const envProviderId = envProviderIdRaw != null && envProviderIdRaw !== '' ? Number(envProviderIdRaw) : undefined

    // Convert our curated options to Synapse SDK options
    const sdkOptions: StorageServiceOptions = {
      ...DEFAULT_STORAGE_CONTEXT_CONFIG,
    }

    // Apply dataset options
    if (options?.dataset?.useExisting != null) {
      sdkOptions.dataSetId = options.dataset.useExisting
      logger.info(
        { event: 'synapse.storage.dataset.existing', dataSetId: options.dataset.useExisting },
        'Connecting to existing dataset'
      )
    } else if (options?.dataset?.createNew === true) {
      sdkOptions.forceCreateDataSet = true
      logger.info({ event: 'synapse.storage.dataset.create_new' }, 'Forcing creation of new dataset')
    }

    // Merge metadata (dataset metadata takes precedence)
    sdkOptions.metadata = {
      ...DEFAULT_DATA_SET_METADATA,
      ...options?.dataset?.metadata,
    }

    /**
     * Callbacks provide visibility into the storage lifecycle
     * These are crucial for debugging and monitoring in production
     */
    const callbacks: StorageCreationCallbacks = {
      onProviderSelected: (provider) => {
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

        options?.callbacks?.onProviderSelected?.(provider)
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

        options?.callbacks?.onDataSetResolved?.(info)
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

        options?.callbacks?.onDataSetCreationStarted?.(transaction)
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
    }

    sdkOptions.callbacks = callbacks

    // Apply provider override if present
    if (envProviderAddress) {
      sdkOptions.providerAddress = envProviderAddress
      logger.info(
        { event: 'synapse.storage.provider_override', by: 'env', providerAddress: envProviderAddress },
        'Overriding provider via PROVIDER_ADDRESS'
      )
    } else if (envProviderId != null && Number.isFinite(envProviderId)) {
      sdkOptions.providerId = envProviderId
      logger.info(
        { event: 'synapse.storage.provider_override', by: 'env', providerId: envProviderId },
        'Overriding provider via PROVIDER_ID'
      )
    }

    const storage = await synapse.storage.createContext(sdkOptions)

    logger.info(
      {
        event: 'synapse.storage.created',
        dataSetId: storage.dataSetId,
        serviceProvider: storage.serviceProvider,
      },
      'Storage context created successfully'
    )

    // Store instance
    storageInstance = storage

    // Ensure we always have provider info
    if (!currentProviderInfo) {
      // This should not happen as provider is selected during context creation
      throw new Error('Provider information not available after storage context creation')
    }

    return { storage, providerInfo: currentProviderInfo }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error(
      {
        event: 'synapse.storage.create.failed',
        error: errorMessage,
      },
      `Failed to create storage context: ${errorMessage}`
    )
    throw error
  }
}

/**
 * Set up complete Synapse service with SDK and storage context
 *
 * This function demonstrates the complete setup flow for Synapse:
 * 1. Validates required configuration (private key)
 * 2. Creates Synapse instance with network configuration
 * 3. Creates a storage context with comprehensive callbacks
 * 4. Returns a service object for application use
 *
 * Our wrapping of Synapse initialization and storage context creation is
 * primarily to handle our custom configuration needs and add detailed logging
 * and progress tracking.
 *
 * @param config - Application configuration with privateKey and RPC URL
 * @param logger - Logger instance for detailed operation tracking
 * @param options - Optional dataset selection and callbacks
 * @returns SynapseService with initialized Synapse and storage context
 *
 * @example
 * ```typescript
 * // Standard setup (reuses wallet's dataset)
 * const service = await setupSynapse(config, logger)
 *
 * // Create new dataset for multi-user scenario
 * const service = await setupSynapse(config, logger, {
 *   dataset: { createNew: true }
 * })
 *
 * // Connect to specific dataset
 * const service = await setupSynapse(config, logger, {
 *   dataset: { useExisting: 123 }
 * })
 * ```
 */
export async function setupSynapse(
  config: SynapseSetupConfig,
  logger: Logger,
  options?: CreateStorageContextOptions
): Promise<SynapseService> {
  // Initialize SDK
  const synapse = await initializeSynapse(config, logger)

  // Create storage context
  const { storage, providerInfo } = await createStorageContext(synapse, logger, options)

  return { synapse, storage, providerInfo }
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
 * Clean up a WebSocket provider connection
 * This is important for allowing the Node.js process to exit cleanly
 *
 * @param provider - The provider to clean up
 */
export async function cleanupProvider(provider: any): Promise<void> {
  if (provider && typeof provider.destroy === 'function') {
    try {
      await provider.destroy()
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Clean up WebSocket providers and other resources
 *
 * Call this when CLI commands are finishing to ensure proper cleanup
 * and allow the process to terminate
 */
export async function cleanupSynapseService(): Promise<void> {
  if (activeProvider) {
    await cleanupProvider(activeProvider)
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
  if (synapseInstance == null || storageInstance == null || currentProviderInfo == null) {
    return null
  }

  return {
    synapse: synapseInstance,
    storage: storageInstance,
    providerInfo: currentProviderInfo,
  }
}
