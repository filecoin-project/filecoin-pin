/**
 * Session key creation for delegated access to Synapse SDK
 *
 * This module provides functionality to create and authorize session keys
 * for use with the Synapse SDK, allowing delegated access without exposing
 * the main private key.
 */

import { DefaultFwssPermissions, loginSync } from '@filoz/synapse-core/session-key'
import type { Chain } from '@filoz/synapse-sdk'
import { type Address, createWalletClient, type Hex, http, type LocalAccount } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { APPLICATION_SOURCE } from '../synapse/constants.js'

export interface SessionKeyResult {
  /** The session key account (newly generated or derived from sessionPrivateKey) */
  sessionAccount: LocalAccount
  /** Private key (hex) of the session wallet */
  sessionPrivateKey: Hex
  /** The owner account that authorized the session key */
  ownerAccount: LocalAccount
  /** Unix timestamp when the session key expires */
  expiry: number
  /** Number of days the session key is valid */
  validityDays: number
  /** The session key registry contract address used */
  registryAddress: Address
  /** The RPC URL used */
  rpcUrl: string
}

export interface CreateSessionKeyOptions {
  /** Private key of the wallet that will authorize the session key */
  privateKey: Hex
  /** Optional session wallet private key. If omitted, a random key is generated. */
  sessionPrivateKey?: Hex
  /** Number of days the session key should be valid (default: 10) */
  validityDays?: number
  /** Target Filecoin chain */
  chain: Chain
  /** RPC URL to use (must be HTTP for JsonRpc transactions) */
  rpcUrl: string
  /** Optional override for the session key registry contract address */
  registryAddress?: Address
  /** Progress callback for logging/UI updates */
  onProgress?: (step: string, details?: Record<string, string>) => void
}

/**
 * Creates and authorizes a new session key for use with Synapse SDK.
 *
 * 1. Resolves a session wallet (provided or freshly generated)
 * 2. Calculates the expiry timestamp from validity days
 * 3. Calls the session-key registry's `login()` to authorize the session key with
 *    CreateDataSet + AddPieces permissions
 *
 * @param options - Configuration for session key creation
 * @returns Session key information including accounts, expiry, and registry details
 */
export async function createSessionKey(options: CreateSessionKeyOptions): Promise<SessionKeyResult> {
  const { privateKey, sessionPrivateKey: providedSessionKey, validityDays = 10, chain, rpcUrl, onProgress } = options

  let sessionPrivateKey: Hex
  if (providedSessionKey) {
    onProgress?.('Using provided session private key...', {})
    sessionPrivateKey = providedSessionKey
  } else {
    onProgress?.('Generating new session key...', {})
    sessionPrivateKey = generatePrivateKey()
  }
  const sessionAccount = privateKeyToAccount(sessionPrivateKey)
  onProgress?.(providedSessionKey ? 'Using provided session key' : 'Generated session key', {
    address: sessionAccount.address,
    privateKey: `${sessionPrivateKey.slice(0, 20)}...`,
  })

  onProgress?.('Calculating expiry timestamp...', {})
  const currentTime = Math.floor(Date.now() / 1000)
  const expiry = currentTime + validityDays * 24 * 60 * 60
  const expiryDate = new Date(expiry * 1000).toISOString()
  onProgress?.('Calculated expiry', {
    expiry: expiryDate,
    validityDays: String(validityDays),
  })

  onProgress?.('Initializing wallet and resolving registry address...', {})
  const ownerAccount = privateKeyToAccount(privateKey)
  const registryAddress = options.registryAddress ?? chain.contracts.sessionKeyRegistry.address
  if (!registryAddress) {
    throw new Error(`No session key registry address configured for chain id ${chain.id}`)
  }
  onProgress?.('Owner wallet initialized', {
    address: ownerAccount.address,
    registry: registryAddress,
  })

  const client = createWalletClient({
    account: ownerAccount,
    chain,
    transport: http(rpcUrl),
  })

  onProgress?.('Authorizing session key on-chain (this may take a minute)...', {
    registry: registryAddress,
    rpcUrl,
  })

  const { receipt } = await loginSync(client, {
    address: sessionAccount.address,
    permissions: DefaultFwssPermissions,
    expiresAt: BigInt(expiry),
    origin: APPLICATION_SOURCE,
    contractAddress: registryAddress,
    onHash: (hash) => onProgress?.('Transaction submitted', { txHash: hash }),
  })
  onProgress?.('Transaction confirmed', {
    txHash: receipt.transactionHash,
    blockNumber: String(receipt.blockNumber),
  })

  return {
    sessionAccount,
    sessionPrivateKey,
    ownerAccount,
    expiry,
    validityDays,
    registryAddress,
    rpcUrl,
  }
}

/**
 * Formats session key result for display to the user
 */
export function formatSessionKeyOutput(result: SessionKeyResult): string {
  const expiryDate = new Date(result.expiry * 1000).toISOString().replace('T', ' ').split('.')[0]

  return `
==========================================
Session key created successfully!
==========================================
Validity: ${result.validityDays} days (expires: ${expiryDate})

Add these to your .env file:
------------------------------------------
WALLET_ADDRESS=${result.ownerAccount.address}
SESSION_KEY=${result.sessionPrivateKey}

Session key info (for debugging):
------------------------------------------
SESSION_KEY_ADDRESS=${result.sessionAccount.address}
OWNER_ADDRESS=${result.ownerAccount.address}
REGISTRY=${result.registryAddress}
EXPIRY=${result.expiry}
`.trim()
}
