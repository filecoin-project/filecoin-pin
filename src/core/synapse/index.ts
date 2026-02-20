import {
  ADD_PIECES_TYPEHASH,
  CREATE_DATA_SET_TYPEHASH,
  type ProviderInfo,
  RPC_URLS,
  type StorageContext,
  type StorageContextCallbacks,
  type StorageServiceOptions,
  Synapse,
  type SynapseOptions,
} from '@filoz/synapse-sdk'
import { type Provider as EthersProvider, JsonRpcProvider, type Signer, Wallet, WebSocketProvider } from 'ethers'
import type { Logger } from 'pino'
import { ADDRESS_ONLY_SIGNER_SYMBOL, AddressOnlySigner } from './address-only-signer.js'
import { DEFAULT_DATA_SET_METADATA, DEFAULT_STORAGE_CONTEXT_CONFIG } from './constants.js'

export * from './constants.js'

const WEBSOCKET_REGEX = /^ws(s)?:\/\//i
const AUTH_MODE_SYMBOL = Symbol.for('filecoin-pin.authMode')

let synapseInstance: Synapse | null = null
let storageInstance: StorageContext | null = null
let currentProviderInfo: ProviderInfo | null = null
let activeProvider: any = null // Track the provider for cleanup
type AuthMode = 'standard' | 'session-key' | 'read-only' | 'signer'

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
 * Common options for all Synapse configurations
 */
interface BaseSynapseConfig extends Omit<SynapseOptions, 'withCDN' | 'warmStorageAddress'> {
  /** RPC endpoint for the target Filecoin network. Defaults to calibration. */
  rpcUrl?: string | undefined
  /** Optional override for WarmStorage contract address */
  warmStorageAddress?: string | undefined
  /** Optional flag for read-only auth (address-only signer) */
  readOnly?: boolean | undefined
  withCDN?: boolean | undefined
  /** Default metadata to apply when creating or reusing datasets */
  dataSetMetadata?: Record<string, string>
}

/**
 * Standard authentication with private key
 */
export interface PrivateKeyConfig extends BaseSynapseConfig {
  privateKey: string
}

/**
 * Session key authentication with wallet address and session key
 */
export interface SessionKeyConfig extends BaseSynapseConfig {
  walletAddress: string
  sessionKey: string
}

/**
 * Read-only authentication using an address-only signer
 *
 * This supports querying balances and status without signing transactions.
 */
export interface ReadOnlyConfig extends BaseSynapseConfig {
  walletAddress: string
  readOnly: true
}

/**
 * Signer-based authentication with ethers Signer
 */
export interface SignerConfig extends BaseSynapseConfig {
  signer: Signer
  /** Target Filecoin network (required for signer mode to determine default RPC) */
  network: 'mainnet' | 'calibration'
}

/**
 * Configuration for Synapse initialization
 *
 * Supports three authentication modes:
 * 1. Standard: privateKey only
 * 2. Session Key: walletAddress + sessionKey
 * 3. Signer: ethers Signer instance
 */
export type SynapseSetupConfig = PrivateKeyConfig | SessionKeyConfig | ReadOnlyConfig | SignerConfig

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
  providerAddress?: string

  /**
   * Override provider selection by ID.
   */
  providerId?: number

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
  activeProvider = null
}

function setAuthMode(synapse: Synapse, mode: AuthMode): void {
  ;(synapse as any)[AUTH_MODE_SYMBOL] = mode
}

export function isViewOnlyMode(synapse: Synapse): boolean {
  try {
    return (synapse as any)[AUTH_MODE_SYMBOL] === 'read-only'
  } catch {
    return false
  }
}

/**
 * Check if Synapse is using session key authentication
 *
 * Session key authentication uses an AddressOnlySigner which cannot sign transactions.
 * Payment operations (deposits, allowances) must be done by the owner wallet separately.
 *
 * Uses a Symbol to reliably detect AddressOnlySigner even across module boundaries.
 *
 * @param synapse - Initialized Synapse instance
 * @returns true if using session key authentication, false otherwise
 */
export function isSessionKeyMode(synapse: Synapse): boolean {
  try {
    const markedMode = (synapse as any)[AUTH_MODE_SYMBOL]
    if (markedMode === 'session-key') return true
    if (markedMode === 'read-only') return false

    const client = synapse.getClient()

    // The client might be wrapped in a NonceManager, check the underlying signer
    let signerToCheck: any = client
    if ('signer' in client && client.signer) {
      signerToCheck = client.signer
    }

    // Check for the AddressOnlySigner symbol (most reliable)
    return ADDRESS_ONLY_SIGNER_SYMBOL in signerToCheck && signerToCheck[ADDRESS_ONLY_SIGNER_SYMBOL] === true
  } catch {
    return false
  }
}

/**
 * Type guards for authentication configuration
 */
function isPrivateKeyConfig(config: Partial<SynapseSetupConfig>): config is PrivateKeyConfig {
  return 'privateKey' in config && config.privateKey != null
}

function isSessionKeyConfig(config: Partial<SynapseSetupConfig>): config is SessionKeyConfig {
  return (
    'walletAddress' in config && 'sessionKey' in config && config.walletAddress != null && config.sessionKey != null
  )
}

function isReadOnlyConfig(config: Partial<SynapseSetupConfig>): config is ReadOnlyConfig {
  return config.readOnly === true && 'walletAddress' in config && config.walletAddress != null
}

function isSignerConfig(config: Partial<SynapseSetupConfig>): config is SignerConfig {
  return 'signer' in config && config.signer != null
}

/**
 * Validate authentication configuration
 */
function validateAuthConfig(config: Partial<SynapseSetupConfig>): 'standard' | 'session-key' | 'read-only' | 'signer' {
  const hasPrivateKey = isPrivateKeyConfig(config)
  const hasSessionKey = isSessionKeyConfig(config)
  const hasReadOnly = isReadOnlyConfig(config)
  const hasSigner = isSignerConfig(config)

  const authCount = [hasPrivateKey, hasSessionKey, hasReadOnly, hasSigner].filter(Boolean).length

  if (authCount === 0) {
    throw new Error(
      'Authentication required: provide either privateKey, walletAddress + sessionKey, view-address, or signer'
    )
  }

  if (authCount > 1) {
    throw new Error(
      'Conflicting authentication: provide only one of privateKey, walletAddress + sessionKey, view-address, or signer'
    )
  }

  if (hasPrivateKey) return 'standard'
  if (hasSessionKey) return 'session-key'
  if (hasReadOnly) return 'read-only'
  return 'signer'
}

/**
 * Create ethers provider for the given RPC URL
 */
function createProvider(rpcURL: string): EthersProvider {
  if (WEBSOCKET_REGEX.test(rpcURL)) {
    return new WebSocketProvider(rpcURL)
  }
  return new JsonRpcProvider(rpcURL)
}

/**
 * Setup and verify session key, throws if expired
 */
async function setupSessionKey(synapse: Synapse, sessionWallet: Wallet, logger: Logger): Promise<void> {
  const sessionKey = synapse.createSessionKey(sessionWallet)

  // Verify permissions - fail fast if expired or expiring soon
  const expiries = await sessionKey.fetchExpiries([CREATE_DATA_SET_TYPEHASH, ADD_PIECES_TYPEHASH])
  const now = Math.floor(Date.now() / 1000)
  const bufferTime = 30 * 60 // 30 minutes in seconds
  const minValidTime = now + bufferTime
  const createDataSetExpiry = Number(expiries[CREATE_DATA_SET_TYPEHASH])
  const addPiecesExpiry = Number(expiries[ADD_PIECES_TYPEHASH])

  // For CREATE_DATA_SET:
  // - 0 means no permission granted (OK - can still add to existing datasets)
  // - > 0 but < minValidTime means expired/expiring (ERROR)
  // - >= minValidTime means valid (OK)
  const hasCreateDataSetPermission = createDataSetExpiry > 0
  const isCreateDataSetPermissionUnavailable = hasCreateDataSetPermission && createDataSetExpiry < minValidTime

  // For ADD_PIECES:
  // - Must always have valid permission
  const isAddPiecesPermissionUnavailable = addPiecesExpiry <= minValidTime

  if (isCreateDataSetPermissionUnavailable) {
    throw new Error(
      `Session key expired or expiring soon (requires 30+ minutes validity). CreateDataSet: ${new Date(createDataSetExpiry * 1000).toISOString()}`
    )
  }

  if (isAddPiecesPermissionUnavailable) {
    throw new Error(
      `Session key expired or expiring soon (requires 30+ minutes validity). AddPieces: ${new Date(addPiecesExpiry * 1000).toISOString()}`
    )
  }

  if (!hasCreateDataSetPermission) {
    logger.info(
      { event: 'synapse.session_key.limited_permissions' },
      'Session key can only add pieces to existing datasets (no CREATE_DATA_SET permission)'
    )
  }

  logger.info(
    {
      event: 'synapse.session_key.verified',
      createExpiry: createDataSetExpiry,
      addExpiry: addPiecesExpiry,
    },
    'Session key verified'
  )

  synapse.setSession(sessionKey)
  logger.info({ event: 'synapse.session_key.activated' }, 'Session key activated')
}

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
  const { withCDN, warmStorageAddress, ...restConfig } = config
  try {
    const authMode = validateAuthConfig(config)

    // Determine RPC URL based on auth mode
    let rpcURL: string
    if (isSignerConfig(config)) {
      rpcURL = config.rpcUrl ?? RPC_URLS[config.network].websocket
    } else {
      rpcURL = config.rpcUrl ?? RPC_URLS.calibration.websocket
    }

    logger.info({ event: 'synapse.init', authMode, rpcUrl: rpcURL }, 'Initializing Synapse SDK')

    const synapseOptions: SynapseOptions = {
      ...restConfig,
      rpcURL,
      withIpni: true, // Always filter for IPNI-enabled providers
    }
    if (withCDN) {
      synapseOptions.withCDN = true
    }
    if (warmStorageAddress) {
      synapseOptions.warmStorageAddress = warmStorageAddress
    }

    let synapse: Synapse

    if (authMode === 'session-key') {
      // Session key mode - type guard ensures these are defined
      if (!isSessionKeyConfig(config)) {
        throw new Error('Internal error: session key mode but config type mismatch')
      }

      // Create provider and signers for session key mode
      const provider = createProvider(rpcURL)
      activeProvider = provider

      const ownerSigner = new AddressOnlySigner(config.walletAddress, provider)
      const sessionWallet = new Wallet(config.sessionKey, provider)

      // Initialize with owner signer, then activate session key
      synapse = await Synapse.create({
        ...synapseOptions,
        signer: ownerSigner,
      })
      await setupSessionKey(synapse, sessionWallet, logger)
      setAuthMode(synapse, 'session-key')
    } else if (authMode === 'read-only') {
      // Read-only mode - type guard ensures walletAddress is defined
      if (!isReadOnlyConfig(config)) {
        throw new Error('Internal error: read-only mode but config type mismatch')
      }

      const provider = createProvider(rpcURL)
      activeProvider = provider

      const readOnlySigner = new AddressOnlySigner(config.walletAddress, provider)

      synapse = await Synapse.create({
        ...synapseOptions,
        signer: readOnlySigner,
      })
      setAuthMode(synapse, 'read-only')
    } else if (authMode === 'signer') {
      // Signer mode - type guard ensures signer is defined
      if (!isSignerConfig(config)) {
        throw new Error('Internal error: signer mode but config type mismatch')
      }

      synapse = await Synapse.create({
        ...synapseOptions,
        signer: config.signer,
      })
      activeProvider = synapse.getProvider()
      setAuthMode(synapse, 'signer')
    } else {
      // Private key mode - type guard ensures privateKey is defined
      if (!isPrivateKeyConfig(config)) {
        throw new Error('Internal error: private key mode but config type mismatch')
      }

      synapse = await Synapse.create({
        ...synapseOptions,
        privateKey: config.privateKey,
      })
      activeProvider = synapse.getProvider()
      setAuthMode(synapse, 'standard')
    }

    const network = synapse.getNetwork()
    logger.info({ event: 'synapse.init.success', network }, 'Synapse SDK initialized')

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
 *   dataset: { useExisting: 123 }
 * })
 *
 * // Default behavior (reuse wallet's dataset)
 * const { storage } = await createStorageContext(synapse, { logger })
 * ```
 */
export async function createStorageContext(
  synapse: Synapse,
  options?: CreateStorageContextOptions
): Promise<{ storage: StorageContext; providerInfo: ProviderInfo }> {
  const logger = options?.logger

  try {
    // Create storage context with comprehensive event tracking
    // The storage context manages the data set and provider interactions
    logger?.info?.({ event: 'synapse.storage.create' }, 'Creating storage context')

    // Convert our curated options to Synapse SDK options
    const sdkOptions: StorageServiceOptions = {
      ...DEFAULT_STORAGE_CONTEXT_CONFIG,
    }

    // Use existing dataset if specified
    if (options?.dataset?.useExisting != null) {
      sdkOptions.dataSetId = options.dataset.useExisting
    }

    if (options?.dataset?.createNew === true) {
      // If explicitly creating a new dataset in session key mode, verify we have permission
      if (isSessionKeyMode(synapse)) {
        const signer = synapse.getSigner()
        const sessionKey = synapse.createSessionKey(signer)

        const expiries = await sessionKey.fetchExpiries([CREATE_DATA_SET_TYPEHASH])
        const createDataSetExpiry = Number(expiries[CREATE_DATA_SET_TYPEHASH])

        if (createDataSetExpiry === 0) {
          throw new Error(
            'Cannot create new dataset: Session key does not have CREATE_DATA_SET permission. ' +
              'Either use an existing dataset or obtain a session key with dataset creation rights.'
          )
        }
      }

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
              serviceURL: provider.products?.PDP?.data?.serviceURL,
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
      sdkOptions.providerAddress = options.providerAddress
      logger?.info?.(
        {
          event: 'synapse.storage.provider_override',
          providerAddress: options.providerAddress,
        },
        'Overriding provider by address'
      )
    } else if (options?.providerId != null && Number.isFinite(options.providerId)) {
      sdkOptions.providerId = options.providerId
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

    // Ensure we always have provider info
    if (!currentProviderInfo) {
      // This should not happen as provider is selected during context creation
      throw new Error('Provider information not available after storage context creation')
    }

    return { storage, providerInfo: currentProviderInfo }
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
 * Clean up a WebSocket provider connection
 * This is important for allowing the Node.js process to exit cleanly
 *
 * @param provider - The provider to clean up
 */
export async function cleanupProvider(provider: any): Promise<void> {
  if (provider && typeof provider.destroy === 'function') {
    // Suppress all errors during cleanup
    // WebSocket providers can throw async errors from scheduled operations
    // (like eth_unsubscribe) after destroy() is called
    const errorHandler = () => {
      // Silently ignore all cleanup errors
    }

    // Add error listener to suppress errors from async operations
    if (typeof provider.on === 'function') {
      provider.on('error', errorHandler)
    }

    try {
      await provider.destroy()
    } catch {
      // Ignore cleanup errors
    }

    // Small delay to allow any pending async operations to complete
    // This prevents errors from scheduled operations that trigger after destroy()
    await new Promise((resolve) => setTimeout(resolve, 100))
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
