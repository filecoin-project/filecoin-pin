/**
 * Shared types for session key authorization.
 */

import type { Permission } from '@filoz/synapse-core/session-key'
import type { Address, Hash, Hex } from 'viem'
import type { ProgressEvent } from '../utils/types.js'

/**
 * Progress events emitted while authorizing a session key on-chain.
 */
export type AuthorizeSessionProgressEvents =
  | ProgressEvent<'authorizeSession:submitting', { sessionAddress: Address; registryAddress: Address }>
  | ProgressEvent<'authorizeSession:submitted', { txHash: Hash; sessionAddress: Address }>
  | ProgressEvent<
      'authorizeSession:confirmed',
      { txHash: Hash; blockNumber: bigint; sessionAddress: Address; expiry: number }
    >

/**
 * Progress events emitted while creating + authorizing a session key in one flow.
 *
 * Extends {@link AuthorizeSessionProgressEvents} with the local-generation events.
 */
export type CreateSessionKeyProgressEvents =
  | AuthorizeSessionProgressEvents
  | ProgressEvent<'createSessionKey:generated', { sessionAddress: Address }>
  | ProgressEvent<'createSessionKey:reusedSessionKey', { sessionAddress: Address }>

export interface SessionKeypair {
  privateKey: Hex
  address: Address
}

export interface AuthorizeSessionResult {
  /** Owner that signed the on-chain `login()` */
  ownerAddress: Address
  /** Session key address that was authorized */
  sessionAddress: Address
  /** Session key registry contract address */
  registryAddress: Address
  /** Permissions granted */
  permissions: readonly Permission[]
  /** Unix timestamp (seconds) when the authorization expires */
  expiry: number
  /** Number of days the authorization is valid (echoed from input) */
  validityDays: number
  /** Hash of the `login()` transaction */
  txHash: Hash
  /** Block number the transaction was mined in */
  blockNumber: bigint
  /** Chain id the authorization was performed on */
  chainId: number
}

export interface CreateSessionKeyResult extends AuthorizeSessionResult {
  /** Session wallet private key (single-party flow, also when caller supplied it). */
  sessionPrivateKey: Hex
}
