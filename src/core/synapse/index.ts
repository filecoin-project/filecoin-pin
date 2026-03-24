/**
 * Synapse SDK initialization for filecoin-pin
 *
 * Maps CLI-friendly configuration (private key strings, RPC URLs) to the
 * SDK's viem-based options (Accounts, Transports, Chains). Consumers use
 * the returned Synapse instance directly for storage operations.
 *
 * @module core/synapse
 */

import { type Chain, calibration, mainnet, Synapse, type SynapseOptions } from '@filoz/synapse-sdk'

export { calibration, mainnet, type Chain }

import type { SessionKey } from '@filoz/synapse-core/session-key'
import { fromSecp256k1 } from '@filoz/synapse-core/session-key'
import type { Logger } from 'pino'
import { type Account, custom, getAddress, type HttpTransport, http, type WebSocketTransport, webSocket } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { APPLICATION_SOURCE } from './constants.js'

export * from './constants.js'

const WEBSOCKET_REGEX = /^ws(s)?:\/\//i

/**
 * Application configuration for CLI and pinning server
 */
export interface Config {
  port: number
  host: string
  privateKey: string | undefined
  walletAddress: string | undefined
  sessionKey: string | undefined
  viewAddress: string | undefined
  rpcUrl: string
  databasePath: string
  carStoragePath: string
  logLevel: string
}

/**
 * Common options for all Synapse configurations
 */
interface BaseSynapseConfig {
  /** RPC endpoint for the target Filecoin network. Defaults to calibration chain transport. */
  rpcUrl?: string
  /** Target chain. Defaults to calibration. */
  chain?: Chain
  /** Enable CDN service for datasets */
  withCDN?: boolean
  /** Default metadata to apply when creating datasets */
  dataSetMetadata?: Record<string, string>
}

/**
 * Standard authentication with private key
 */
export interface PrivateKeyConfig extends BaseSynapseConfig {
  privateKey: `0x${string}`
}

/**
 * Session key authentication with owner address and session key private key
 */
export interface SessionKeyConfig extends BaseSynapseConfig {
  walletAddress: `0x${string}`
  sessionKey: `0x${string}`
}

/**
 * Read-only mode using an address (cannot sign transactions)
 */
export interface ReadOnlyConfig extends BaseSynapseConfig {
  walletAddress: `0x${string}`
  readOnly: true
}

/**
 * Pre-created viem Account
 */
export interface AccountConfig extends BaseSynapseConfig {
  account: Account
}

/**
 * Configuration for Synapse initialization.
 *
 * Supports four authentication modes:
 * 1. Private key: hex-encoded private key string
 * 2. Session key: owner wallet address + session key private key
 * 3. Read-only: wallet address for querying without signing
 * 4. Account: pre-created viem Account instance
 */
export type SynapseSetupConfig = PrivateKeyConfig | SessionKeyConfig | ReadOnlyConfig | AccountConfig

function isPrivateKeyConfig(config: SynapseSetupConfig): config is PrivateKeyConfig {
  return 'privateKey' in config && config.privateKey != null
}

function isSessionKeyConfig(config: SynapseSetupConfig): config is SessionKeyConfig {
  return (
    'walletAddress' in config &&
    'sessionKey' in config &&
    config.walletAddress != null &&
    (config as SessionKeyConfig).sessionKey != null &&
    !('readOnly' in config && (config as ReadOnlyConfig).readOnly === true)
  )
}

function isReadOnlyConfig(config: SynapseSetupConfig): config is ReadOnlyConfig {
  return 'readOnly' in config && (config as ReadOnlyConfig).readOnly === true && 'walletAddress' in config
}

function createTransport(rpcUrl: string): HttpTransport | WebSocketTransport {
  if (WEBSOCKET_REGEX.test(rpcUrl)) {
    return webSocket(rpcUrl)
  }
  return http(rpcUrl)
}

/**
 * Create a Synapse instance from CLI-friendly configuration.
 *
 * @param config - Authentication and network configuration
 * @param logger - Optional logger for initialization events
 * @returns Initialized Synapse instance
 */
export async function initializeSynapse(config: SynapseSetupConfig, logger?: Logger): Promise<Synapse> {
  const chain = config.chain ?? calibration
  const rpcUrl = config.rpcUrl ?? chain.rpcUrls.default.webSocket?.[0] ?? chain.rpcUrls.default.http[0]
  const transport = rpcUrl ? createTransport(rpcUrl) : undefined

  let account: Account | `0x${string}`
  let sessionKey: SessionKey<'Secp256k1'> | undefined

  if (isReadOnlyConfig(config)) {
    account = getAddress(config.walletAddress)
    logger?.info({ event: 'synapse.init', mode: 'read-only' }, 'Initializing Synapse (read-only)')
  } else if (isSessionKeyConfig(config)) {
    const walletAddress = getAddress(config.walletAddress)
    account = walletAddress
    sessionKey = fromSecp256k1({
      privateKey: config.sessionKey,
      root: walletAddress,
      chain,
      ...(transport ? { transport } : {}),
    })
    await sessionKey.syncExpirations()
    logger?.info({ event: 'synapse.init', mode: 'session-key' }, 'Initializing Synapse (session key)')
  } else if (isPrivateKeyConfig(config)) {
    account = privateKeyToAccount(config.privateKey)
    logger?.info({ event: 'synapse.init', mode: 'private-key' }, 'Initializing Synapse')
  } else if ('account' in config && config.account != null) {
    account = config.account
    logger?.info({ event: 'synapse.init', mode: 'account' }, 'Initializing Synapse (pre-created account)')
  } else {
    throw new Error(
      'No authentication provided. Supply a private key (--private-key / PRIVATE_KEY), ' +
        'wallet address (--wallet-address / WALLET_ADDRESS), or session key (--session-key / SESSION_KEY).'
    )
  }

  const synapseOptions: SynapseOptions = {
    account,
    chain,
    source: APPLICATION_SOURCE,
  }

  if (transport) {
    // Synapse SDK rejects non-custom transports for json-rpc accounts (where
    // account is a bare address string rather than a full Account object).
    // Both read-only and session key modes use bare addresses, so wrap in
    // custom() to satisfy the guard while preserving the underlying transport.
    if (typeof account === 'string') {
      const resolved = transport({ chain, retryCount: 0 })
      synapseOptions.transport = custom({ request: resolved.request })
    } else {
      synapseOptions.transport = transport
    }
  }
  if (sessionKey) {
    synapseOptions.sessionKey = sessionKey
  }
  if (config.withCDN) {
    synapseOptions.withCDN = config.withCDN
  }

  const synapse = Synapse.create(synapseOptions)
  logger?.info({ event: 'synapse.init.success', chain: synapse.chain.name }, 'Synapse initialized')

  return synapse
}

/**
 * Extract the client wallet address from a Synapse instance.
 *
 * Handles both string addresses (read-only / session key mode) and
 * full Account objects (private key mode).
 */
export function getClientAddress(synapse: Synapse): `0x${string}` {
  const account = synapse.client.account
  return (typeof account === 'string' ? account : account.address) as `0x${string}`
}

/**
 * Check if Synapse is using session key authentication.
 *
 * Session key mode restricts transaction signing to scoped operations;
 * payment setup must be done by the owner wallet separately.
 */
export function isSessionKeyMode(synapse: Synapse): boolean {
  return synapse.sessionClient != null
}
