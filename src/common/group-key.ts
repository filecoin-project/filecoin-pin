/**
 * Keysmith key derivation for `add --encrypt` and `decrypt`.
 *
 * filecoin-pin names Keysmith's concepts for its users: a Keysmith *keyspace* is a
 * **group key** here, and a Keysmith *scope* is a **group**. The on-chain and envelope
 * labels keep Keysmith's names (`foc/ks`, `foc/kc`, `foc/scope`).
 *
 * One owner wallet signature per group key derives every key beneath it. Nothing is
 * stored: the group key id, a public commitment and the `foc/enc` format version ride
 * in data set metadata, every envelope names its own group key and salt, and the wallet
 * alone reads the data back.
 */

import {
  keyspaceKeys as deriveGroupKey,
  COMMITMENT_KEY as GROUP_KEY_COMMITMENT_KEY,
  KEYSPACE_ID_KEY as GROUP_KEY_ID_KEY,
  keyForEnvelope,
  newKeyspace as newGroupKeyId,
  newSalt,
  type PieceMetadata,
  pieceKey,
  pieceMetadata,
  type TypedDataSigner,
  type WriteTarget,
  writeTarget,
} from '@filoz/keysmith'
import type { Synapse } from '@filoz/synapse-sdk'
import type { KeyResolver } from 'filecoin-encryption-envelope'
import type { Logger } from 'pino'
import type { Address, Hex } from 'viem'
import { type DataSetSummary, listDataSets } from '../core/data-set/index.js'

/** A wallet that can sign for a group key (Keysmith's `KeyspaceKey` message): the owner's own key, never a session key. */
export type OwnerSigner = TypedDataSigner & { address: Address }

export const OWNER_WALLET_REQUIRED =
  'Encrypted uploads need the owner wallet: set PRIVATE_KEY. Session keys will get access through the console in a later release.'

/** The signing wallet behind a Synapse client; undefined for a session key or a read-only client. */
export function ownerSigner(synapse: Synapse): OwnerSigner | undefined {
  const account = synapse.client.account as Partial<OwnerSigner> | string | undefined
  return typeof account === 'object' && typeof account.signTypedData === 'function'
    ? (account as OwnerSigner)
    : undefined
}

/** Data set metadata key that marks a data set as encrypted and versions its rules. */
export const ENCRYPTION_VERSION_KEY = 'foc/enc'

/** The only `foc/enc` value this version writes and reuses. */
export const ENCRYPTION_VERSION = '1'

/** Keys that mark a data set as encrypted; a plain upload never reuses a data set carrying any of them. */
export const ENCRYPTED_DATA_SET_KEYS: readonly string[] = [
  GROUP_KEY_ID_KEY,
  GROUP_KEY_COMMITMENT_KEY,
  ENCRYPTION_VERSION_KEY,
]

export interface OwnerGroupKey {
  /** Where new pieces are written: the group key itself, with no group. */
  target: WriteTarget
  /** `foc/enc`, `foc/ks` and `foc/kc`, carried by every data set the upload writes to. */
  dataSetMetadata: Record<string, string>
}

/**
 * The group key this wallet encrypts under: the oldest valid one its data sets
 * record (see {@link oldestValidGroupKey}), else a new one. Every copy of an
 * upload lands in data sets of this one group key.
 *
 * @throws If the recorded commitment does not match this wallet's key.
 */
export async function ownerGroupKey(synapse: Synapse, signer: OwnerSigner, logger?: Logger): Promise<OwnerGroupKey> {
  const tagged = await listDataSets(synapse, {
    filter: (dataSet) => dataSet.isLive && typeof dataSet.metadata?.[GROUP_KEY_ID_KEY] === 'string',
    ...(logger != null && { logger }),
  })
  const recorded = oldestValidGroupKey(tagged, logger)
  const groupKeyId = recorded?.groupKeyId ?? newGroupKeyId()
  const keys = await deriveGroupKey(
    signer,
    { owner: signer.address, keyspace: groupKeyId },
    recorded == null ? {} : { commitment: recorded.commitment }
  )
  return {
    target: writeTarget(keys.descriptor, keys.kk),
    dataSetMetadata: {
      [ENCRYPTION_VERSION_KEY]: ENCRYPTION_VERSION,
      [GROUP_KEY_ID_KEY]: groupKeyId,
      [GROUP_KEY_COMMITMENT_KEY]: keys.commitment,
    },
  }
}

/**
 * "Oldest wins": sort data sets by their group key (`foc/ks`), skip any group key
 * whose data sets disagree on `foc/kc` or are not all `foc/enc` "1", and return
 * the remaining group key that holds the lowest data set id.
 *
 * Inconsistent group keys are skipped rather than refused so that one bad group
 * key cannot block every encrypted upload; the skip is logged.
 */
export function oldestValidGroupKey(
  dataSets: DataSetSummary[],
  logger?: Logger
): { groupKeyId: Hex; commitment: string } | undefined {
  const byGroupKey = new Map<string, DataSetSummary[]>()
  for (const dataSet of dataSets) {
    const groupKeyId = dataSet.metadata?.[GROUP_KEY_ID_KEY]
    if (typeof groupKeyId !== 'string') continue
    const members = byGroupKey.get(groupKeyId)
    if (members == null) byGroupKey.set(groupKeyId, [dataSet])
    else members.push(dataSet)
  }

  let best: { groupKeyId: Hex; commitment: string; oldest: bigint } | undefined
  for (const [groupKeyId, members] of byGroupKey) {
    const commitments = new Set(members.map((dataSet) => dataSet.metadata?.[GROUP_KEY_COMMITMENT_KEY]))
    const commitment = members[0]?.metadata?.[GROUP_KEY_COMMITMENT_KEY]
    const versioned = members.every((dataSet) => dataSet.metadata?.[ENCRYPTION_VERSION_KEY] === ENCRYPTION_VERSION)
    if (commitments.size !== 1 || typeof commitment !== 'string' || !versioned) {
      logger?.warn(
        {
          event: 'group-key.skipped',
          groupKeyId,
          dataSetIds: members.map((dataSet) => dataSet.dataSetId.toString()),
        },
        'Skipping group key: its data sets disagree on foc/kc or are not foc/enc "1"'
      )
      continue
    }
    const oldest = members.reduce(
      (min, dataSet) => (dataSet.dataSetId < min ? dataSet.dataSetId : min),
      members[0]?.dataSetId ?? 0n
    )
    if (best == null || oldest < best.oldest) {
      best = { groupKeyId: groupKeyId as Hex, commitment, oldest }
    }
  }
  return best == null ? undefined : { groupKeyId: best.groupKeyId, commitment: best.commitment }
}

/** The key for one upload and the labels its envelope carries. */
export interface PieceKey {
  cek: Uint8Array
  appMetadata: PieceMetadata
}

/** A fresh key for one upload. Never reused: FEE needs a new key per object. */
export function newPieceKey(target: WriteTarget): PieceKey {
  const salt = newSalt()
  return {
    cek: pieceKey(target.key, salt),
    // Keysmith calls a group a scope; it is written as `foc/scope` when present.
    appMetadata: pieceMetadata(target.ref, { salt, ...(target.scope != null && { scope: target.scope }) }),
  }
}

export class NotOwnerError extends Error {
  constructor(owner: string, wallet: string) {
    super(`This upload belongs to ${owner}; the wallet in PRIVATE_KEY is ${wallet}`)
    this.name = 'NotOwnerError'
  }
}

/**
 * A FEE key resolver for the owner wallet: signs for the group key the envelope
 * names and derives the piece key from its labels. Signs twice, since there is
 * no data set commitment to check against offline.
 */
export function ownerKeyResolver(signer: OwnerSigner): KeyResolver {
  return async ({ appMetadata }) => {
    const groupKeyId = appMetadata?.['foc/ks']
    if (appMetadata?.['foc/v'] !== 1 || typeof groupKeyId !== 'string') {
      throw new Error('not a Keysmith envelope')
    }
    const owner = appMetadata['foc/own']
    const wallet = signer.address.toLowerCase()
    if (typeof owner !== 'string' || owner.toLowerCase() !== wallet) {
      throw new NotOwnerError(String(owner), wallet)
    }
    const { kk } = await deriveGroupKey(signer, { owner: signer.address, keyspace: groupKeyId as Hex })
    return keyForEnvelope(kk, appMetadata)
  }
}
