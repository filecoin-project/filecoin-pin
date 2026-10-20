/**
 * Keysmith key derivation for `add --encrypt` and `decrypt`.
 *
 * One owner wallet signature per keyspace derives every key beneath it
 * (`@filoz/keysmith`). Nothing is stored: the keyspace id and a public
 * commitment ride in data set metadata, every envelope names its own keyspace
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
import { listDataSets } from '../core/data-set/index.js'

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

export interface OwnerKeyspace {
  /** Where new pieces are written: the keyspace key, unscoped. */
  target: WriteTarget
  /** `foc/ks` and `foc/kc`, carried by every data set the upload writes to. */
  dataSetMetadata: Record<string, string>
}

/**
 * The keyspace this wallet encrypts under: the one its data sets already
 * record, else a new one. One keyspace per wallet, so every encrypted upload
 * lands in the same data sets and one signature reads them all back.
 *
 * @throws If the recorded commitment does not match this wallet's key.
 */
export async function ownerKeyspace(synapse: Synapse, signer: OwnerSigner, logger?: Logger): Promise<OwnerKeyspace> {
  const tagged = await listDataSets(synapse, {
    filter: (dataSet) => dataSet.isLive && typeof dataSet.metadata?.[KEYSPACE_ID_KEY] === 'string',
    ...(logger != null && { logger }),
  })
  tagged.sort((a, b) => Number(a.dataSetId - b.dataSetId))
  const recorded = tagged[0]?.metadata
  const keyspace = (recorded?.[KEYSPACE_ID_KEY] as Hex | undefined) ?? newKeyspace()
  const commitment = recorded?.[COMMITMENT_KEY]
  const keys = await keyspaceKeys(signer, { owner: signer.address, keyspace }, commitment == null ? {} : { commitment })
  return {
    target: writeTarget(keys.descriptor, keys.kk),
    dataSetMetadata: { [KEYSPACE_ID_KEY]: keyspace, [COMMITMENT_KEY]: keys.commitment },
  }
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
