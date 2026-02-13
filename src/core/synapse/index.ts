// import { SessionKey } from "@filoz/synapse-sdk/session";

import type { PDPProvider } from '@filoz/synapse-sdk'
import {
  calibration,
  type mainnet,
  type StorageContextCallbacks,
  type StorageServiceOptions,
  Synapse,
  type SynapseOptions,
} from '@filoz/synapse-sdk'
import type { StorageContext } from '@filoz/synapse-sdk/storage'
import type { Logger } from 'pino'
import { type Hex, http, webSocket } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { DEFAULT_DATA_SET_METADATA, DEFAULT_STORAGE_CONTEXT_CONFIG } from './constants.js'

export * from './constants.js'

const AUTH_MODE_SYMBOL = Symbol.for('filecoin-pin.authMode')

let synapseInstance: Synapse | null = null
let storageInstance: StorageContext | null = null
let currentProviderInfo: PDPProvider | null = null
type AuthMode = 'standard' /* | "session-key" */

/**
 * Complete application configuration interface
 * This is the main config interface that can be imported by CLI and other consumers
 */
export interface Config {
  port: number
  host: string
  privateKey: `0x${string}` | undefined
  rpcUrl: string
  warmStorageAddress?: string | undefined
  databasePath: string
  // TODO: remove this from core?
  carStoragePath: string
  logLevel: string
}

/**
 * Common options for all Synapse configurations
 */
interface BaseSynapseConfig extends Omit<SynapseOptions, 'withCDN'> {
  chain?: typeof mainnet | typeof calibration
  withCDN?: boolean | undefined
  /** RPC URL for chain connection (used to create transport) */
  rpcUrl?: string
  /** Optional warm storage contract address override */
  warmStorageAddress?: string
  /** Default metadata to apply when creating or reusing datasets */
  dataSetMetadata?: Record<string, string>
}

/**
 * Standard authentication with private key (hex string)
 */
export interface PrivateKeyConfig extends BaseSynapseConfig {
  /** Private key as hex string (0x...) - used with privateKeyToAccount */
  account: Hex
}

/**
 * Session key authentication with wallet address and session key
 */
export interface SessionKeyConfig extends BaseSynapseConfig {
  walletAddress: string
  sessionKey: string
}

export interface SignerConfig extends BaseSynapseConfig {
  signer: any // Signer
}

/**
 * Configuration for Synapse initialization
 *
 * Supports three authentication modes:
 * 1. Standard: privateKey only
 * 2. Session Key: walletAddress + sessionKey
 * 3. Signer: ethers Signer instance
 */
export type SynapseSetupConfig = PrivateKeyConfig | SessionKeyConfig // | SignerConfig

/**
 * Structured service object containing the fully initialized Synapse SDK and
 * its storage context
 */
export interface SynapseService {
  synapse: Synapse
  storage: StorageContext
  providerInfo: PDPProvider
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
  useExisting?: bigint

  /**
   * Custom metadata to attach to the dataset.
   *
   * Note: If `useExisting` is provided, metadata is ignored since you're
   * connecting to an existing dataset.
   */
  metadata?: Record<string, string>
}

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
  callbacks?: StorageContextCallbacks

  /**
   * Override provider selection by address.
   * Takes precedence over providerId if both are specified.
   */
  providerAddress?: `0x${string}`

  /**
   * Override provider selection by ID.
   */
  providerId?: bigint

  /**
   * Optional logger instance for detailed operation tracking and progress callbacks.
   * If not provided, logging will be skipped.
   */
  logger?: Partial<Logger> | undefined
}

/**
 * Reset the service instances (for testing)
 */
export function resetSynapseService(): void {
  synapseInstance = null
  storageInstance = null
  currentProviderInfo = null
}

function setAuthMode(synapse: Synapse, mode: AuthMode): void {
  ;(synapse as any)[AUTH_MODE_SYMBOL] = mode
}

// /**
//  * Check if Synapse is using session key authentication
//  *
//  * Session key authentication uses an AddressOnlySigner which cannot sign transactions.
//  * Payment operations (deposits, allowances) must be done by the owner wallet separately.
//  *
//  * Uses a Symbol to reliably detect AddressOnlySigner even across module boundaries.
//  *
//  * @param synapse - Initialized Synapse instance
//  * @returns true if using session key authentication, false otherwise
//  */
// export function isSessionKeyMode(synapse: Synapse): boolean {
//   try {
//     const markedMode = (synapse as any)[AUTH_MODE_SYMBOL];
//     if (markedMode === "session-key") return true;

//     // The client might be wrapped in a NonceManager, check the underlying signer
//     let signerToCheck: any = synapse.client;
//     if ("signer" in synapse.client && synapse.client.signer) {
//       signerToCheck = synapse.client.signer;
//     }

//     // Check for the AddressOnlySigner symbol (most reliable)
//     return (
//       ADDRESS_ONLY_SIGNER_SYMBOL in signerToCheck &&
//       signerToCheck[ADDRESS_ONLY_SIGNER_SYMBOL] === true
//     );
//   } catch {
//     return false;
//   }
// }

/**
 * Type guards for authentication configuration
 * Standard auth is recognized by config.account (set from private key by parseCLIAuth).
 */
function isPrivateKeyConfig(config: Partial<SynapseSetupConfig>): config is PrivateKeyConfig {
  return 'account' in config && config.account != null
}

function isSessionKeyConfig(config: Partial<SynapseSetupConfig>): config is SessionKeyConfig {
  return (
    'walletAddress' in config && 'sessionKey' in config && config.walletAddress != null && config.sessionKey != null
  )
}

function isSignerConfig(config: Partial<SynapseSetupConfig>): config is SignerConfig {
  return 'signer' in config && config.signer != null
}

/**
 * Validate authentication configuration
 */
function validateAuthConfig(config: Partial<SynapseSetupConfig>): 'standard' | 'session-key' | 'signer' {
  const hasPrivateKey = isPrivateKeyConfig(config)
  const hasSessionKey = isSessionKeyConfig(config)
  const hasSigner = isSignerConfig(config)

  const authCount = [hasPrivateKey, hasSigner, hasSessionKey].filter(Boolean).length

  if (authCount === 0) {
    throw new Error(
      'Authentication required: provide privateKey'
      // + " or walletAddress + sessionKey" +
    )
  }

  if (authCount > 1) {
    throw new Error(
      'Conflicting authentication: provide only one of privateKey'
      // + " or walletAddress + sessionKey" +
    )
  }

  if (hasSessionKey) return 'session-key'
  if (hasSigner) return 'signer'

  return 'standard'
}

// /**
//  * Setup and verify session key, throws if expired
//  */
// async function setupSessionKey(
//   synapse: Synapse,
//   sessionWallet: Wallet,
//   logger: Logger,
// ): Promise<void> {
//   const sessionKey = new SessionKey(synapse.client, sessionWallet);

//   // Verify permissions - fail fast if expired or expiring soon
//   const expiries = await sessionKey.fetchExpiries([
//     CREATE_DATA_SET_TYPEHASH,
//     ADD_PIECES_TYPEHASH,
//   ]);
//   const now = Math.floor(Date.now() / 1000);
//   const bufferTime = 30 * 60; // 30 minutes in seconds
//   const minValidTime = now + bufferTime;
//   const createDataSetExpiry = Number(expiries[CREATE_DATA_SET_TYPEHASH]);
//   const addPiecesExpiry = Number(expiries[ADD_PIECES_TYPEHASH]);

//   // For CREATE_DATA_SET:
//   // - 0 means no permission granted (OK - can still add to existing datasets)
//   // - > 0 but < minValidTime means expired/expiring (ERROR)
//   // - >= minValidTime means valid (OK)
//   const hasCreateDataSetPermission = createDataSetExpiry > 0;
//   const isCreateDataSetPermissionUnavailable =
//     hasCreateDataSetPermission && createDataSetExpiry < minValidTime;

//   // For ADD_PIECES:
//   // - Must always have valid permission
//   const isAddPiecesPermissionUnavailable = addPiecesExpiry <= minValidTime;

//   if (isCreateDataSetPermissionUnavailable) {
//     throw new Error(
//       `Session key expired or expiring soon (requires 30+ minutes validity). CreateDataSet: ${new Date(createDataSetExpiry * 1000).toISOString()}`,
//     );
//   }

//   if (isAddPiecesPermissionUnavailable) {
//     throw new Error(
//       `Session key expired or expiring soon (requires 30+ minutes validity). AddPieces: ${new Date(addPiecesExpiry * 1000).toISOString()}`,
//     );
//   }

//   if (!hasCreateDataSetPermission) {
//     logger.info(
//       { event: "synapse.session_key.limited_permissions" },
//       "Session key can only add pieces to existing datasets (no CREATE_DATA_SET permission)",
//     );
//   }

//   logger.info(
//     {
//       event: "synapse.session_key.verified",
//       createExpiry: createDataSetExpiry,
//       addExpiry: addPiecesExpiry,
//     },
//     "Session key verified",
//   );

//   synapse.setSession(sessionKey);
//   logger.info(
//     { event: "synapse.session_key.activated" },
//     "Session key activated",
//   );
// }

/**
 * Initialize the Synapse SDK without creating storage context
 *
 * Supports three authentication modes:
 * - Standard: privateKey only
 * - Session Key: walletAddress + sessionKey
 * - Signer: ethers Signer instance
 *
 * @param config - Application configuration with authentication credentials
 * @param logger - Logger instance for detailed operation tracking
 * @returns Initialized Synapse instance
 */
export async function initializeSynapse(config: Partial<SynapseSetupConfig>, logger: Logger): Promise<Synapse> {
  const { withCDN, ...restConfig } = config
  try {
    const authMode = validateAuthConfig(config)

    // Determine RPC URL based on auth mode
    const chain = isSignerConfig(config) ? config.chain : calibration

    logger.info({ event: 'synapse.init', authMode, chain }, 'Initializing Synapse SDK')

    const rpcUrl = (restConfig as { rpcUrl?: string }).rpcUrl ?? calibration.rpcUrls.default.http[0] ?? ''
    const transport = rpcUrl.startsWith('ws') ? webSocket(rpcUrl) : http(rpcUrl)
    const synapseOptions: Omit<SynapseOptions, 'account'> = {
      chain: chain as typeof mainnet | typeof calibration,
      transport,
      withCDN: withCDN === true,
    }

    // if (authMode === "session-key") {
    //   // Session key mode - type guard ensures these are defined
    //   if (!isSessionKeyConfig(config)) {
    //     throw new Error(
    //       "Internal error: session key mode but config type mismatch",
    //     );
    //   }

    //   // Create provider and signers for session key mode
    //   const provider = createProvider(rpcURL);

    //   const ownerSigner = new AddressOnlySigner(config.walletAddress, provider);
    //   const sessionWallet = new Wallet(config.sessionKey, provider);

    //   // Initialize with owner signer, then activate session key
    //   synapse = await Synapse.create({
    //     ...synapseOptions,
    //     signer: ownerSigner,
    //   });
    //   await setupSessionKey(synapse, sessionWallet, logger);
    //   setAuthMode(synapse, "session-key");
    // } else {
    if (authMode === 'session-key') {
      throw new Error('Session key authentication is not yet implemented; use account (private key) authentication.')
    }
    // Private key mode - type guard ensures account is defined
    if (!isPrivateKeyConfig(config)) {
      throw new Error('Internal error: private key mode but config type mismatch')
    }

    const synapse = await Synapse.create({
      ...synapseOptions,
      account: privateKeyToAccount(config.account),
    })
    setAuthMode(synapse, 'standard')
    // }
    logger.info({ event: 'synapse.init.success', network: synapse.chain.name }, 'Synapse SDK initialized')

    synapseInstance = synapse
    return synapse
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error({ event: 'synapse.init.failed', error: errorMessage }, 'Failed to initialize Synapse SDK')
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
 * const { storage } = await createStorageContext(synapse, {
 *   logger,
 *   dataset: { createNew: true }
 * })
 *
 * // Connect to existing dataset
 * const { storage } = await createStorageContext(synapse, {
 *   logger,
 *   dataset: { useExisting: 123n }
 * })
 *
 * // Default behavior (reuse wallet's dataset)
 * const { storage } = await createStorageContext(synapse, { logger })
 * ```
 */
export async function createStorageContext(
  synapse: Synapse,
  options?: CreateStorageContextOptions
): Promise<{ storage: StorageContext; providerInfo: PDPProvider }> {
  const logger = options?.logger

  try {
    // Create storage context with comprehensive event tracking
    // The storage context manages the data set and provider interactions
    logger?.info?.({ event: 'synapse.storage.create' }, 'Creating storage context')

    // Convert our curated options to Synapse SDK options
    const sdkOptions: StorageServiceOptions = {
      ...DEFAULT_STORAGE_CONTEXT_CONFIG,
    }

    // Apply dataset options
    if (options?.dataset?.useExisting != null) {
      sdkOptions.dataSetId = options.dataset.useExisting
      logger?.info?.(
        {
          event: 'synapse.storage.dataset.existing',
          dataSetId: options.dataset.useExisting,
        },
        'Connecting to existing dataset'
      )
    } else if (options?.dataset?.createNew === true) {
      // // If explicitly creating a new dataset in session key mode, verify we have permission
      // if (isSessionKeyMode(synapse)) {
      //   const signer = synapse.getSigner();
      //   const sessionKey = synapse.createSessionKey(signer);

      //   const expiries = await sessionKey.fetchExpiries([
      //     CREATE_DATA_SET_TYPEHASH,
      //   ]);
      //   const createDataSetExpiry = Number(expiries[CREATE_DATA_SET_TYPEHASH]);

      //   if (createDataSetExpiry === 0) {
      //     throw new Error(
      //       "Cannot create new dataset: Session key does not have CREATE_DATA_SET permission. " +
      //         "Either use an existing dataset or obtain a session key with dataset creation rights.",
      //     );
      //   }
      // }

      sdkOptions.forceCreateDataSet = true
      logger?.info?.({ event: 'synapse.storage.dataset.create_new' }, 'Forcing creation of new dataset')
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
    const callbacks: StorageContextCallbacks = {
      onProviderSelected: (provider) => {
        currentProviderInfo = provider

        logger?.info?.(
          {
            event: 'synapse.storage.provider_selected',
            provider: {
              id: provider.id,
              serviceProvider: provider.serviceProvider,
              name: provider.name,
              serviceURL: provider.pdp.serviceURL,
            },
          },
          'Selected storage provider'
        )

        options?.callbacks?.onProviderSelected?.(provider)
      },
      onDataSetResolved: (info) => {
        logger?.info?.(
          {
            event: 'synapse.storage.data_set_resolved',
            dataSetId: info.dataSetId,
            isExisting: info.isExisting,
          },
          info.isExisting ? 'Using existing data set' : 'Created new data set'
        )

        options?.callbacks?.onDataSetResolved?.(info)
      },
    }

    sdkOptions.callbacks = callbacks

    // Apply provider override if present
    if (options?.providerAddress) {
      sdkOptions.providerAddress = options.providerAddress as Hex
      logger?.info?.(
        {
          event: 'synapse.storage.provider_override',
          providerAddress: options.providerAddress,
        },
        'Overriding provider by address'
      )
    } else if (options?.providerId != null) {
      sdkOptions.providerId = typeof options.providerId === 'bigint' ? options.providerId : BigInt(options.providerId)
      logger?.info?.(
        {
          event: 'synapse.storage.provider_override',
          providerId: options.providerId,
        },
        'Overriding provider by ID'
      )
    }

    const storage = await synapse.storage.createContext(sdkOptions)

    logger?.info?.(
      {
        event: 'synapse.storage.created',
        dataSetId: storage.dataSetId,
        serviceProvider: storage.serviceProvider,
      },
      'Storage context created successfully'
    )

    // Store instance
    storageInstance = storage
    currentProviderInfo = storage.provider

    return { storage, providerInfo: storage.provider }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger?.error?.(
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
 *   dataset: { useExisting: 123n }
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
  let storageOptions = options ? { ...options } : undefined
  if (config.dataSetMetadata && Object.keys(config.dataSetMetadata).length > 0) {
    storageOptions = {
      ...(storageOptions ?? {}),
      dataset: {
        ...(storageOptions?.dataset ?? {}),
        metadata: {
          ...config.dataSetMetadata,
          ...(storageOptions?.dataset?.metadata ?? {}),
        },
      },
    }
  }

  const { storage, providerInfo } = await createStorageContext(synapse, {
    ...(storageOptions ?? {}),
    logger,
  })

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
 * Clean up WebSocket providers and other resources
 *
 * Call this when CLI commands are finishing to ensure proper cleanup
 * and allow the process to terminate
 */
export async function cleanupSynapseService(): Promise<void> {
  // Clear references
  synapseInstance = null
  storageInstance = null
  currentProviderInfo = null
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
