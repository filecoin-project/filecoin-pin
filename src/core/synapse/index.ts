/**
 * Synapse SDK initialization for filecoin-pin
 *
 * Maps CLI-friendly configuration (private key strings, RPC URLs) to the
 * SDK's viem-based options (Accounts, Transports, Chains). Consumers use
 * the returned Synapse instance directly for storage operations.
 *
 * @module core/synapse
 */

import { calibration, type FilecoinChain, mainnet, Synapse, type SynapseOptions } from '@filoz/synapse-sdk'

export { calibration, mainnet, type FilecoinChain }

import type { SessionKey } from '@filoz/synapse-core/session-key'
import { fromSecp256k1, type Permission, PermissionNames } from '@filoz/synapse-core/session-key'
import type { Logger } from 'pino'
import {
  type Account,
  type Address,
  custom,
  getAddress,
  type Hex,
  type HttpTransport,
  type WebSocketTransport,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { buildAuthorizeUrl, resolveConsoleUrl } from '../session/console-url.js'
import { scopeIdOf } from '../session/scopes.js'
import { APPLICATION_SOURCE } from './constants.js'
import { createTransport } from './create-transport.js'
import { resolveChainFromRpc } from './resolve-chain-from-rpc.js'

export * from './constants.js'
export { createTransport } from './create-transport.js'

/**
 * Application configuration for CLI and pinning server
 */
export interface Config {
  port: number
  host: string
  privateKey: string | undefined
  walletAddress: string | undefined
  sessionKey: string | undefined
  accessToken: string | undefined
  /** Allow the pinning server to start without an access token, serving all requests unauthenticated. */
  allowNoAuth?: boolean
  rpcUrl: string
  chain?: FilecoinChain
  databasePath: string
  carStoragePath: string
  logLevel: string
}

/**
 * Common options for all Synapse configurations
 */
interface BaseSynapseConfig {
  /** RPC endpoint for the target Filecoin network. Defaults to mainnet chain transport. */
  rpcUrl?: string
  /** Target chain. Defaults to mainnet. */
  chain?: FilecoinChain
  /** Enable CDN service for datasets */
  withCDN?: boolean
  /** Default metadata to apply when creating datasets */
  dataSetMetadata?: Record<string, string>
  /**
   * Session-key mode only: the permissions this command needs. Before doing
   * any work, we check the session key's on-chain grants cover these. If one
   * is missing, the command stops immediately with instructions for getting
   * it granted (console link), rather than failing later mid-transaction.
   * Leave unset for read-only commands — they need no permissions.
   */
  requiredPermissions?: Permission[]
}

/**
 * Standard authentication with private key
 */
export interface PrivateKeyConfig extends BaseSynapseConfig {
  privateKey: Hex
}

/**
 * Session key authentication with owner address and session key private key
 */
export interface SessionKeyConfig extends BaseSynapseConfig {
  walletAddress: Address
  sessionKey: Hex
}

/**
 * Read-only mode using an address (cannot sign transactions)
 */
export interface ReadOnlyConfig extends BaseSynapseConfig {
  walletAddress: Address
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

/** True when the config authenticates with a session key (owner address + session private key). */
export function isSessionKeyConfig(config: SynapseSetupConfig): config is SessionKeyConfig {
  return (
    'walletAddress' in config &&
    'sessionKey' in config &&
    config.walletAddress != null &&
    (config as SessionKeyConfig).sessionKey != null &&
    !('readOnly' in config && (config as ReadOnlyConfig).readOnly === true)
  )
}

/** True when the config is a view-only wallet address (no signer). */
export function isReadOnlyConfig(config: SynapseSetupConfig): config is ReadOnlyConfig {
  return 'readOnly' in config && (config as ReadOnlyConfig).readOnly === true && 'walletAddress' in config
}
/**
 * Reject malformed session key material before it reaches the SDK, whose own
 * error ("invalid private key, expected hex or 32 bytes") never names the flag.
 */
export function assertSessionKeyPrivateKey(value: string): asserts value is Hex {
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return
  const detail = /^(0x)?[0-9a-fA-F]{40}$/.test(value)
    ? 'this looks like an address, but the session key private key (0x-prefixed, 64 hex characters) is required'
    : 'expected the session key private key (0x-prefixed, 64 hex characters)'
  throw new Error(
    `Invalid --session-key / SESSION_KEY: ${detail}. ` +
      'Use the SESSION_KEY value printed by "filecoin-pin session create" or "filecoin-pin session generate".'
  )
}

/**
 * First line of the preflight error. Three shapes: nothing ever granted,
 * every needed grant lapsed (the session expired: renew it with `login`),
 * or a live key that lacks a scope.
 */
function describeProblem(
  key: SessionKey<'Secp256k1'>,
  ownerAddress: string,
  scopeLabels: string,
  networkName: string,
  now: bigint
): string {
  const allExpirations = Object.values(key.expirations)
  const neverAuthorized = allExpirations.length > 0 && allExpirations.every((expiry) => expiry === 0n)
  if (neverAuthorized) {
    return `Session key ${key.address} isn't authorized for account ${ownerAddress} on ${networkName} — never authorized, expired/revoked, or the key is for a different network (check --network).`
  }
  // No live grant at all, but at least one past grant: the session ran out.
  if (allExpirations.every((expiry) => expiry <= now)) {
    const latest = allExpirations.reduce((a, b) => (a > b ? a : b), 0n)
    const date = new Date(Number(latest) * 1000).toISOString().slice(0, 10)
    return `Session expired (key ${key.address}, grants lapsed ${date})\n  Renew it:  filecoin-pin login`
  }
  return `Session key ${key.address} lacks ${scopeLabels} for this operation on ${networkName}.`
}

/**
 * Preflight a session key against the permissions an operation needs.
 *
 * Two failure shapes, both console-first (spec: problem -> console
 * recommended -> owner CLI). Never tells a delegate to run a root-key
 * command as their own action.
 *
 *  - Not authorized at all: every on-chain expiration is 0 (never granted,
 *    or fully expired/revoked — on-chain state can't tell those apart).
 *  - Missing the required scope: some grant is live, but not the one this
 *    operation needs.
 */
function checkSessionKeyPermissions(
  key: SessionKey<'Secp256k1'>,
  ownerAddress: string,
  required: Permission[],
  chainId: number,
  networkName: string
): void {
  const missing = required.filter((p) => !key.hasPermission(p))
  if (missing.length === 0) return

  const scopeIds = missing.map(scopeIdOf)
  const scopeLabels = missing.map((p) => PermissionNames[p] ?? p).join(', ')
  const scopesArg = scopeIds.join(',')

  // Per-scope detail preserves the expired-at vs never-granted distinction
  // the on-chain expirations carry — an expired grant points at renewal,
  // a never-granted scope points at a fresh authorization.
  const now = BigInt(Math.floor(Date.now() / 1000))
  const scopeDetails = missing.map((p) => {
    const name = PermissionNames[p] ?? p
    const expiry = key.expirations[p] ?? 0n
    if (expiry > 0n && expiry <= now) {
      return `  • ${name}: expired at ${new Date(Number(expiry) * 1000).toISOString()}`
    }
    return `  • ${name}: never granted`
  })

  const problem = describeProblem(key, ownerAddress, scopeLabels, networkName, now)

  const lines = [problem, ...scopeDetails, '']
  lines.push('Recommended — approve in the browser with the owner wallet:')
  // Plain text: this is a library error, so no terminal styling here.
  lines.push(`  ${buildAuthorizeUrl(resolveConsoleUrl(), key.address, scopeIds, chainId)}`)
  lines.push('')
  lines.push('The account owner can also use the CLI:')
  lines.push(`  filecoin-pin session authorize ${key.address} --scopes ${scopesArg}   (adds to this key, no new key)`)
  if (neverAuthorized) {
    lines.push(`  filecoin-pin session create --scopes ${scopesArg}              (or mint a new scoped key)`)
  }
  lines.push('')
  lines.push('Then re-run this command.')

  throw new Error(lines.join('\n'))
}

/**
 * Create a Synapse instance from CLI-friendly configuration.
 *
 * @param config - Authentication and network configuration
 * @param logger - Optional logger for initialization events
 * @returns Initialized Synapse instance
 */
export async function initializeSynapse(config: SynapseSetupConfig, logger?: Logger): Promise<Synapse> {
  // Validate key material before any network I/O (the RPC chain probe below)
  // so a malformed --session-key fails fast even when the RPC endpoint is down.
  if (isSessionKeyConfig(config)) {
    assertSessionKeyPrivateKey(config.sessionKey)
  }

  let chain: FilecoinChain
  let rpcUrl: string | undefined
  let transport: HttpTransport | WebSocketTransport | undefined

  if (config.rpcUrl) {
    // Probe the RPC endpoint's chainId so the chain object reflects what the endpoint actually serves.
    // CLI/server callers enforce that --rpc-url is mutually exclusive with --network, so any chain hint
    // here is from a programmatic caller and is treated as advisory.
    rpcUrl = config.rpcUrl
    transport = createTransport(rpcUrl)
    chain = await resolveChainFromRpc(transport, logger)
  } else {
    chain = config.chain ?? mainnet
    rpcUrl = chain.rpcUrls.default.webSocket?.[0] ?? chain.rpcUrls.default.http[0]
    transport = rpcUrl ? createTransport(rpcUrl) : undefined
  }

  let account: Account | Address
  let sessionKey: SessionKey<'Secp256k1'> | undefined

  if (isReadOnlyConfig(config)) {
    account = getAddress(config.walletAddress)
    logger?.info({ event: 'synapse.init', mode: 'read-only' }, 'Initializing Synapse (read-only)')
  } else if (isSessionKeyConfig(config)) {
    const walletAddress = getAddress(config.walletAddress)
    account = walletAddress
    try {
      sessionKey = fromSecp256k1({
        privateKey: config.sessionKey,
        root: walletAddress,
        chain,
        ...(transport ? { transport } : {}),
      })
    } catch (error) {
      // The format gate in assertSessionKeyPrivateKey can't catch key material
      // outside the secp256k1 scalar range (e.g. all zeros).
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Invalid --session-key / SESSION_KEY: ${reason}`, { cause: error })
    }
    await sessionKey.syncExpirations()
    checkSessionKeyPermissions(sessionKey, walletAddress, config.requiredPermissions ?? [], chain.id, chain.name)
    logger?.info({ event: 'synapse.init', mode: 'session-key' }, 'Initializing Synapse (session key)')
  } else if (isPrivateKeyConfig(config)) {
    account = privateKeyToAccount(config.privateKey)
    logger?.info({ event: 'synapse.init', mode: 'private-key' }, 'Initializing Synapse')
  } else if ('account' in config && config.account != null) {
    account = config.account
    logger?.info({ event: 'synapse.init', mode: 'account' }, 'Initializing Synapse (pre-created account)')
  } else {
    const hasWallet = 'walletAddress' in config && config.walletAddress != null
    const hasSessionKey = 'sessionKey' in config && config.sessionKey != null
    if (hasWallet && !hasSessionKey) {
      throw new Error(
        'Session key authentication requires both --wallet-address and --session-key. ' +
          'Missing: --session-key / SESSION_KEY.'
      )
    }
    if (hasSessionKey && !hasWallet) {
      throw new Error(
        'Session key authentication requires both --wallet-address and --session-key. ' +
          'Missing: --wallet-address / WALLET_ADDRESS.'
      )
    }
    throw new Error(
      'No credentials found.\n' +
        '  Log in to your Filecoin account:  filecoin-pin login\n' +
        '  (or supply --private-key / PRIVATE_KEY, or --wallet-address + --session-key / WALLET_ADDRESS + SESSION_KEY)'
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
    // Match the SDK's own permission gate to this command's needs; without it
    // Synapse.create defaults to requiring all FWSS permissions and re-rejects a
    // subset key that our preflight already accepted.
    synapseOptions.requiredPermissions = config.requiredPermissions ?? []
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
export function getClientAddress(synapse: Synapse): Address {
  const account = synapse.client.account
  return (typeof account === 'string' ? account : account.address) as Address
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
