/**
 * Authorize a session key on the on-chain session key registry.
 *
 * Accepts a viem `Client<Transport, Chain, Account>`. The signer and transport
 * are owned by the caller, so any account viem supports (raw key, EIP-1193
 * provider, hardware wallet) can drive the authorization.
 */

import { DefaultFwssPermissions, loginSync, type Permission } from '@filoz/synapse-core/session-key'
import type { Chain } from '@filoz/synapse-sdk'
import { type Account, type Address, type Client, getAddress, keccak256, stringToHex, type Transport } from 'viem'
import { APPLICATION_SOURCE } from '../synapse/constants.js'
import type { ProgressEventHandler } from '../utils/types.js'
import type { AuthorizeSessionProgressEvents, AuthorizeSessionResult } from './types.js'

// TODO: import from `@filoz/synapse-core/session-key` once exported (post 0.42).
// See https://github.com/FilOzone/synapse-sdk/pull/796 — DefaultFwssPermissions
// will drop DeleteDataSet in favor of TerminateService. Registering the union
// now means session keys minted today keep working after the upgrade.
export const TerminateServicePermission = keccak256(stringToHex('TerminateService(uint256 dataSetId)')) as Permission

export const FilecoinPinFwssPermissions: readonly Permission[] = Array.from(
  new Set<Permission>([...DefaultFwssPermissions, TerminateServicePermission])
)

export interface AuthorizeSessionOptions {
  /** Address to authorize. Will be checksummed. */
  sessionAddress: Address
  /** Number of days the authorization is valid (default: 10). Capped at 365 days. */
  validityDays?: number
  /** Permissions to grant. Defaults to {@link FilecoinPinFwssPermissions}. */
  permissions?: readonly Permission[]
  /** Override for the session key registry contract address. */
  registryAddress?: Address
  /** Optional progress event handler */
  onProgress?: ProgressEventHandler<AuthorizeSessionProgressEvents>
}

const MAX_VALIDITY_DAYS = 365

/**
 * Authorize `sessionAddress` to act on behalf of `client.account` on the
 * Filecoin session key registry.
 *
 * @throws if `validityDays` is non-positive or exceeds {@link MAX_VALIDITY_DAYS}
 * @throws if the chain has no `sessionKeyRegistry` and no `registryAddress` override is provided
 */
export async function authorizeSessionAddress(
  client: Client<Transport, Chain, Account>,
  options: AuthorizeSessionOptions
): Promise<AuthorizeSessionResult> {
  const validityDays = options.validityDays ?? 10
  if (!Number.isInteger(validityDays) || validityDays <= 0) {
    throw new Error(`validityDays must be a positive integer, got: ${validityDays}`)
  }
  if (validityDays > MAX_VALIDITY_DAYS) {
    throw new Error(`validityDays must be <= ${MAX_VALIDITY_DAYS}, got: ${validityDays}`)
  }

  const sessionAddress = getAddress(options.sessionAddress)
  const ownerAddress = getAddress(client.account.address)
  const permissions = options.permissions ?? FilecoinPinFwssPermissions
  const registryAddress = options.registryAddress ?? client.chain.contracts.sessionKeyRegistry?.address
  if (!registryAddress) {
    throw new Error(`No session key registry address configured for chain id ${client.chain.id}`)
  }

  options.onProgress?.({
    type: 'authorizeSession:resolving',
    data: { sessionAddress, ownerAddress },
  })

  const expiry = Math.floor(Date.now() / 1000) + validityDays * 24 * 60 * 60

  options.onProgress?.({
    type: 'authorizeSession:submitting',
    data: { sessionAddress, registryAddress },
  })

  const { receipt } = await loginSync(client, {
    address: sessionAddress,
    permissions: Array.from(permissions),
    expiresAt: BigInt(expiry),
    origin: APPLICATION_SOURCE,
    contractAddress: registryAddress,
    onHash: (txHash) =>
      options.onProgress?.({
        type: 'authorizeSession:submitted',
        data: { txHash, sessionAddress },
      }),
  })

  options.onProgress?.({
    type: 'authorizeSession:confirmed',
    data: {
      txHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      sessionAddress,
      expiry,
    },
  })

  return {
    ownerAddress,
    sessionAddress,
    registryAddress,
    permissions,
    expiry,
    validityDays,
    txHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    chainId: client.chain.id,
  }
}

export { MAX_VALIDITY_DAYS }
