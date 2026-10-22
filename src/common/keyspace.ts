/**
 * Keysmith key derivation for `add --encrypt` and `decrypt`.
 *
 * One owner wallet signature per keyspace derives every key beneath it
 * (`@filoz/keysmith`). Nothing is stored: the keyspace id, a public commitment
 * and the `foc/enc` format version ride in data set metadata, every envelope names its own keyspace
 * and salt, and the wallet alone reads the data back.
 */

import {
  COMMITMENT_KEY,
  KEYSPACE_ID_KEY,
  keyForEnvelope,
  keyspaceKeys,
  newKeyspace,
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

/** A wallet that can sign the Keysmith `KeyspaceKey` message: the owner's own key, never a session key. */
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
export const ENCRYPTED_DATA_SET_KEYS: readonly string[] = [KEYSPACE_ID_KEY, COMMITMENT_KEY, ENCRYPTION_VERSION_KEY]

export interface OwnerKeyspace {
  /** Where new pieces are written: the keyspace key, unscoped. */
  target: WriteTarget
  /** `foc/enc`, `foc/ks` and `foc/kc`, carried by every data set the upload writes to. */
  dataSetMetadata: Record<string, string>
}

/**
 * The keyspace this wallet encrypts under: the oldest valid one its data sets
 * record (see {@link oldestValidKeyspace}), else a new one. Every copy of an
 * upload lands in data sets of this one keyspace.
 *
 * @throws If the recorded commitment does not match this wallet's key.
 */
export async function ownerKeyspace(synapse: Synapse, signer: OwnerSigner, logger?: Logger): Promise<OwnerKeyspace> {
  const tagged = await listDataSets(synapse, {
    filter: (dataSet) => dataSet.isLive && typeof dataSet.metadata?.[KEYSPACE_ID_KEY] === 'string',
    ...(logger != null && { logger }),
  })
  const recorded = oldestValidKeyspace(tagged, logger)
  const keyspace = recorded?.keyspace ?? newKeyspace()
  const keys = await keyspaceKeys(
    signer,
    { owner: signer.address, keyspace },
    recorded == null ? {} : { commitment: recorded.commitment }
  )
  return {
    target: writeTarget(keys.descriptor, keys.kk),
    dataSetMetadata: {
      [ENCRYPTION_VERSION_KEY]: ENCRYPTION_VERSION,
      [KEYSPACE_ID_KEY]: keyspace,
      [COMMITMENT_KEY]: keys.commitment,
    },
  }
}

/**
 * "Oldest wins": group data sets by `foc/ks`, skip any group whose data sets
 * disagree on `foc/kc` or are not all `foc/enc` "1", and return the keyspace
 * of the remaining group holding the lowest data set id.
 *
 * Inconsistent groups are skipped rather than refused so that one bad group
 * cannot block every encrypted upload; the skip is logged.
 */
export function oldestValidKeyspace(
  dataSets: DataSetSummary[],
  logger?: Logger
): { keyspace: Hex; commitment: string } | undefined {
  const groups = new Map<string, DataSetSummary[]>()
  for (const dataSet of dataSets) {
    const keyspace = dataSet.metadata?.[KEYSPACE_ID_KEY]
    if (typeof keyspace !== 'string') continue
    const group = groups.get(keyspace)
    if (group == null) groups.set(keyspace, [dataSet])
    else group.push(dataSet)
  }

  let best: { keyspace: Hex; commitment: string; oldest: bigint } | undefined
  for (const [keyspace, group] of groups) {
    const commitments = new Set(group.map((dataSet) => dataSet.metadata?.[COMMITMENT_KEY]))
    const commitment = group[0]?.metadata?.[COMMITMENT_KEY]
    const versioned = group.every((dataSet) => dataSet.metadata?.[ENCRYPTION_VERSION_KEY] === ENCRYPTION_VERSION)
    if (commitments.size !== 1 || typeof commitment !== 'string' || !versioned) {
      logger?.warn(
        { event: 'keyspace.skipped', keyspace, dataSetIds: group.map((dataSet) => dataSet.dataSetId.toString()) },
        'Skipping keyspace: its data sets disagree on foc/kc or are not foc/enc "1"'
      )
      continue
    }
    const oldest = group.reduce(
      (min, dataSet) => (dataSet.dataSetId < min ? dataSet.dataSetId : min),
      group[0]?.dataSetId ?? 0n
    )
    if (best == null || oldest < best.oldest) {
      best = { keyspace: keyspace as Hex, commitment, oldest }
    }
  }
  return best == null ? undefined : { keyspace: best.keyspace, commitment: best.commitment }
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
 * A FEE key resolver for the owner wallet: signs for the keyspace the envelope
 * names and derives the piece key from its labels. Signs twice, since there is
 * no data set commitment to check against offline.
 */
export function ownerKeyResolver(signer: OwnerSigner): KeyResolver {
  return async ({ appMetadata }) => {
    const keyspace = appMetadata?.['foc/ks']
    if (appMetadata?.['foc/v'] !== 1 || typeof keyspace !== 'string') {
      throw new Error('not a Keysmith envelope')
    }
    const owner = appMetadata['foc/own']
    const wallet = signer.address.toLowerCase()
    if (typeof owner !== 'string' || owner.toLowerCase() !== wallet) {
      throw new NotOwnerError(String(owner), wallet)
    }
    const { kk } = await keyspaceKeys(signer, { owner: signer.address, keyspace: keyspace as Hex })
    return keyForEnvelope(kk, appMetadata)
  }
}
