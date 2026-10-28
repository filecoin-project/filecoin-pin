/**
 * Real group key Grants for tests, made the way the console makes them: the owner derives
 * the group key, signs a root claim for the session key, and wraps the key to it.
 */

import {
  keyspaceKeys as deriveGroupKey,
  encodeDelivery,
  grantDescriptor,
  publicKeyOf,
  rootClaim,
  wrapTo,
} from '@filoz/keysmith'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { grantText } from '../../common/group-key-grant.js'

// The well-known Anvil development keys #0 to #3: public test keys, never funded anywhere real.
export const OWNER_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
export const STRANGER_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
export const SESSION_KEY: Hex = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'
export const OTHER_SESSION_KEY: Hex = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'

export const OWNER = privateKeyToAccount(OWNER_KEY)
export const SESSION_ADDRESS = privateKeyToAccount(SESSION_KEY).address

/** defaultGroupKeyId(OWNER): the group key the console picks for an owner with no encrypted data sets. */
export const GROUP_KEY: Hex = '0x02ca08cf7e0222c8432adc159232b7eb'

export const CALIBRATION_CHAIN_ID = 314159

/** 2100-01-01: a Grant that outlives every test run. */
export const FAR_FUTURE = 4102444800

export interface GrantInput {
  ownerKey?: Hex
  sessionKey?: Hex
  groupKey?: Hex
  chainId?: number
  expires?: number
  node?: string
  /** How many levels the session key may re-share: 0, as the console issues them, unless a test needs more. */
  maxDepth?: number
}

/** A Grant (`fgr1_…`) for `sessionKey`, signed by `ownerKey`. */
export async function makeGrant(input: GrantInput = {}): Promise<string> {
  const owner = privateKeyToAccount(input.ownerKey ?? OWNER_KEY)
  const sessionKey = input.sessionKey ?? SESSION_KEY
  const keyspace = input.groupKey ?? GROUP_KEY
  const node = input.node ?? 'keyspace'
  const ref = { owner: owner.address, keyspace }
  const { kk } = await deriveGroupKey(owner, ref)
  const { chain, nodeKey } = await rootClaim(owner, {
    ...ref,
    chainId: BigInt(input.chainId ?? CALIBRATION_CHAIN_ID),
    kk,
    node,
    bearer: privateKeyToAccount(sessionKey).address,
    maxDepth: input.maxDepth ?? 0,
    expires: input.expires ?? FAR_FUTURE,
    // Signed just before it expires, so a test can make an already-expired Grant: Keysmith refuses to sign one.
    now: (input.expires ?? FAR_FUTURE) - 1,
  })
  const grant = await wrapTo(publicKeyOf(sessionKey), nodeKey, grantDescriptor(ref, node as 'keyspace'))
  return grantText(encodeDelivery(chain, grant))
}

/** `foc/kc` of the owner's group key, as the owner-mode upload records it. */
export async function groupKeyCommitment(groupKey: Hex = GROUP_KEY): Promise<string> {
  const { commitment } = await deriveGroupKey(OWNER, { owner: OWNER.address, keyspace: groupKey })
  return commitment
}
