import {
  METADATA_KEYS,
  type ProviderInfo,
  RPC_URLS,
  type StorageContext,
  type StorageServiceOptions,
  Synapse,
  type SynapseOptions,
} from '@filoz/synapse-sdk'
import type { Logger } from 'pino'

const WEBSOCKET_REGEX = /^ws(s)?:\/\//i

/**
 * Default metadata for Synapse data sets created by filecoin-pin.
 */
const DEFAULT_DATA_SET_METADATA = {
  [METADATA_KEYS.WITH_IPFS_INDEXING]: '',
  source: 'filecoin-pin',
} as const

/**
 * Default configuration for creating storage contexts.
 */
const DEFAULT_STORAGE_CONTEXT_CONFIG = {
  withCDN: false,
  metadata: DEFAULT_DATA_SET_METADATA,
} as const

let synapseInstance: Synapse | null = null
let storageInstance: StorageContext | null = null
let currentProviderInfo: ProviderInfo | null = null
let activeProvider: any = null

/**
 * Complete application configuration interface.
 * This is the main config interface that can be imported by CLI and other consumers.
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
 * Configuration for Synapse initialization.
 * Extends the main Config but makes privateKey required and rpcUrl optional.
 */
export interface SynapseSetupConfig extends Partial<Omit<Config, 'privateKey' | 'rpcUrl'>> {
  /** Private key used for signing transactions. */
  privateKey: string
  /** RPC endpoint for the target Filecoin network. Defaults to calibration. */
  rpcUrl?: string | undefined
}

/**
 * Structured service object containing the fully initialized Synapse SDK and
 * its storage context.
 */
export interface SynapseService {
  synapse: Synapse
  storage: StorageContext
  providerInfo: ProviderInfo
}

/**
 * Reset memoized service instances (used primarily in tests between runs).
 */
export function resetSynapseService(): void {
  synapseInstance = null
  storageInstance = null
  currentProviderInfo = null
  activeProvider = null
}

/**
 * Initialize the Synapse SDK without creating a storage context.
 *
 * This function centralises the connection logic so multiple front-ends can
 * share the same behaviour (validation, logging, default RPC selection).
 * It mirrors the previous implementation from `src/synapse/service.ts` while
 * avoiding module-level side effects.
 *
 * @param config - Connection options for Synapse.
 * @param logger - Logger used for structured output during initialization.
 * @returns A ready-to-use Synapse instance.
 * @throws If required configuration is missing or initialization fails.
 */
export async function initializeSynapse(config: SynapseSetupConfig, logger: Logger): Promise<Synapse> {
  try {
    logger.info(
      {
        hasPrivateKey: config.privateKey != null,
        rpcUrl: config.rpcUrl,
      },
      'Initializing Synapse'
    )

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

    const synapseOptions: SynapseOptions = {
      privateKey,
      rpcURL: config.rpcUrl ?? RPC_URLS.calibration.websocket,
    }

    const synapse = await Synapse.create(synapseOptions)

    const network = synapse.getNetwork()
    logger.info(
      {
        event: 'synapse.init',
        network,
        rpcUrl: synapseOptions.rpcURL,
      },
      'Synapse SDK initialized'
    )

    synapseInstance = synapse
    if (synapseOptions.rpcURL && WEBSOCKET_REGEX.test(synapseOptions.rpcURL)) {
      activeProvider = synapse.getProvider()
    } else {
      activeProvider = null
    }

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
 * Build the default storage context configuration, applying optional
 * overrides while keeping the base metadata intact.
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
 * Create a storage context for an initialized Synapse instance.
 *
 * Adds logging and optional progress callbacks around the SDK helper so
 * callers gain insight into provider selection and dataset lifecycle.
 */
export async function createStorageContext(
  synapse: Synapse,
  logger: Logger,
  progressCallbacks?: {
    onProviderSelected?: (provider: any) => void
    onDataSetCreationStarted?: (transaction: any) => void
    onDataSetResolved?: (info: { dataSetId: number; isExisting: boolean }) => void
  }
): Promise<{ storage: StorageContext; providerInfo: ProviderInfo }> {
  try {
    logger.info({ event: 'synapse.storage.create' }, 'Creating storage context')

    const envProviderAddress = process.env.PROVIDER_ADDRESS?.trim()
    const envProviderIdRaw = process.env.PROVIDER_ID?.trim()
    const envProviderId = envProviderIdRaw != null && envProviderIdRaw !== '' ? Number(envProviderIdRaw) : undefined

    const createOptions: StorageServiceOptions = {
      ...DEFAULT_STORAGE_CONTEXT_CONFIG,
      callbacks: {
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

          progressCallbacks?.onProviderSelected?.(provider)
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

          progressCallbacks?.onDataSetResolved?.(info)
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

          progressCallbacks?.onDataSetCreationStarted?.(transaction)
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
    }

    if (envProviderAddress) {
      createOptions.providerAddress = envProviderAddress
      logger.info(
        { event: 'synapse.storage.provider_override', by: 'env', providerAddress: envProviderAddress },
        'Overriding provider via PROVIDER_ADDRESS'
      )
    } else if (envProviderId != null && Number.isFinite(envProviderId)) {
      createOptions.providerId = envProviderId
      logger.info(
        { event: 'synapse.storage.provider_override', by: 'env', providerId: envProviderId },
        'Overriding provider via PROVIDER_ID'
      )
    }

    const storage = await synapse.storage.createContext(createOptions)

    logger.info(
      {
        event: 'synapse.storage.created',
        dataSetId: storage.dataSetId,
        serviceProvider: storage.serviceProvider,
      },
      'Storage context created successfully'
    )

    storageInstance = storage

    if (!currentProviderInfo) {
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
 * Initialize Synapse and establish the storage context in a single step.
 *
 * Convenience wrapper used by the server, CLI imports, and tests expecting a
 * fully configured service object.
 */
export async function setupSynapse(
  config: SynapseSetupConfig,
  logger: Logger,
  progressCallbacks?: {
    onProviderSelected?: (provider: any) => void
    onDataSetCreationStarted?: (transaction: any) => void
    onDataSetResolved?: (info: { dataSetId: number; isExisting: boolean }) => void
  }
): Promise<SynapseService> {
  const synapse = await initializeSynapse(config, logger)
  const { storage, providerInfo } = await createStorageContext(synapse, logger, progressCallbacks)

  return { synapse, storage, providerInfo }
}

/**
 * Clean up a single provider connection if one exists.
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
 * Clean up Synapse service resources (WebSocket provider, cached instances)
 * so long-running processes can shut down cleanly.
 */
export async function cleanupSynapseService(): Promise<void> {
  if (activeProvider) {
    await cleanupProvider(activeProvider)
  }

  synapseInstance = null
  storageInstance = null
  currentProviderInfo = null
  activeProvider = null
}

/**
 * Return the current service snapshot if initialization has already occurred.
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
