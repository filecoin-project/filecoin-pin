/**
 * Revoke Filecoin Pin permissions for a session key on the on-chain session
 * key registry.
 */

import { type Permission, revokeSync } from '@filoz/synapse-core/session-key'
import type { Chain } from '@filoz/synapse-sdk'
import type { Account, Address, Client, Transport } from 'viem'
import { getAddress } from 'viem'
import { APPLICATION_SOURCE } from '../synapse/constants.js'
import type { ProgressEventHandler } from '../utils/types.js'
import { FilecoinPinFwssPermissions } from './authorize-session.js'
import type { RevokeSessionProgressEvents, RevokeSessionResult } from './types.js'

export interface RevokeSessionOptions {
  /** Address to revoke. Will be checksummed. */
  sessionAddress: Address
  /** Permissions to revoke. Defaults to the Filecoin Pin FWSS permission set. */
  permissions?: readonly Permission[]
  /** Override for the session key registry contract address. */
  registryAddress?: Address
  /** Optional progress event handler */
  onProgress?: ProgressEventHandler<RevokeSessionProgressEvents>
}

/**
 * Revoke Filecoin Pin FWSS permissions for `sessionAddress` from
 * `client.account` on the Filecoin session key registry.
 *
 * @throws if the chain has no `sessionKeyRegistry` and no `registryAddress` override is provided
 */
export async function revokeSessionAddress(
  client: Client<Transport, Chain, Account>,
  options: RevokeSessionOptions
): Promise<RevokeSessionResult> {
  const sessionAddress = getAddress(options.sessionAddress)
  const ownerAddress = getAddress(client.account.address)
  const permissions = options.permissions ?? FilecoinPinFwssPermissions
  const registryAddress = options.registryAddress ?? client.chain.contracts.sessionKeyRegistry?.address
  if (!registryAddress) {
    throw new Error(`No session key registry address configured for chain id ${client.chain.id}`)
  }

  options.onProgress?.({
    type: 'revokeSession:resolving',
    data: { sessionAddress, ownerAddress },
  })

  options.onProgress?.({
    type: 'revokeSession:submitting',
    data: { sessionAddress, registryAddress },
  })

  const { receipt } = await revokeSync(client, {
    address: sessionAddress,
    permissions: Array.from(permissions),
    origin: APPLICATION_SOURCE,
    contractAddress: registryAddress,
    onHash: (txHash) =>
      options.onProgress?.({
        type: 'revokeSession:submitted',
        data: { txHash, sessionAddress },
      }),
  })

  options.onProgress?.({
    type: 'revokeSession:confirmed',
    data: {
      txHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      sessionAddress,
    },
  })

  return {
    ownerAddress,
    sessionAddress,
    registryAddress,
    permissions,
    txHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    chainId: client.chain.id,
  }
}
