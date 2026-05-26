/**
 * High-level wrappers around {@link authorizeSessionAddress} for use cases where
 * the caller provides a raw private key (typical CLI flow).
 */

import type { Permission } from '@filoz/synapse-core/session-key'
import type { Chain } from '@filoz/synapse-sdk'
import { type Address, createWalletClient, type Hex, type Transport } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { ProgressEventHandler } from '../utils/types.js'
import { authorizeSessionAddress } from './authorize-session.js'
import type { CreateSessionKeyProgressEvents, CreateSessionKeyResult, SessionKeypair } from './types.js'

/**
 * Generate a fresh secp256k1 keypair. No chain interaction.
 *
 * Any valid EVM address — from this helper, MetaMask, a hardware wallet,
 * `cast wallet new`, etc. — is accepted by {@link authorizeSessionAddress}.
 */
export function generateSessionKeypair(): SessionKeypair {
  const privateKey = generatePrivateKey()
  const { address } = privateKeyToAccount(privateKey)
  return { privateKey, address }
}

export interface CreateSessionKeyOptions {
  /** Owner private key used to sign the on-chain `login()` */
  privateKey: Hex
  /** Optional pre-existing session key. If omitted, a fresh key is generated. */
  sessionPrivateKey?: Hex
  /** Number of days the authorization is valid (default: 10). Capped at 365 days. */
  validityDays?: number
  /** Permissions to grant. */
  permissions?: readonly Permission[]
  /** Target Filecoin chain */
  chain: Chain
  /** viem transport to use for owner-side signing. */
  transport: Transport
  /** Override for the session key registry contract address */
  registryAddress?: Address
  /** Optional progress event handler */
  onProgress?: ProgressEventHandler<CreateSessionKeyProgressEvents>
}

/**
 * Single-party flow: derive an owner client from a raw private key, generate
 * (or reuse) a session key locally, and authorize it on-chain.
 *
 * For the two-party / external-wallet flow, build a viem client and call
 * {@link authorizeSessionAddress} directly.
 */
export async function createSessionKey(options: CreateSessionKeyOptions): Promise<CreateSessionKeyResult> {
  const {
    privateKey,
    sessionPrivateKey: providedSessionKey,
    validityDays,
    permissions,
    chain,
    transport,
    registryAddress,
    onProgress,
  } = options

  const sessionPrivateKey = providedSessionKey ?? generatePrivateKey()
  const sessionAccount = privateKeyToAccount(sessionPrivateKey)

  onProgress?.({
    type: providedSessionKey ? 'createSessionKey:reusedSessionKey' : 'createSessionKey:generated',
    data: { sessionAddress: sessionAccount.address },
  })

  const ownerAccount = privateKeyToAccount(privateKey)
  const client = createWalletClient({ account: ownerAccount, chain, transport })

  const authorizeOptions: Parameters<typeof authorizeSessionAddress>[1] = {
    sessionAddress: sessionAccount.address,
  }
  if (validityDays !== undefined) authorizeOptions.validityDays = validityDays
  if (permissions !== undefined) authorizeOptions.permissions = permissions
  if (registryAddress !== undefined) authorizeOptions.registryAddress = registryAddress
  if (onProgress !== undefined) authorizeOptions.onProgress = onProgress

  const result = await authorizeSessionAddress(client, authorizeOptions)

  return { ...result, sessionPrivateKey }
}
