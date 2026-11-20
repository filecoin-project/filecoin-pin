/**
 * Keysmith key derivation for `add --encrypt` and `decrypt`.
 *
 * Keysmith format 2: data sets record the group key as `foc/gkid` and `foc/kc`; envelopes name
 * their group key (`foc/gkid`), group (`foc/group`, when written under one) and salt.
 * Data from keysmith 0.1.0 (`foc/ks`) is not readable by this version.
 *
 * One owner wallet signature per group key derives every key beneath it. Nothing is
 * stored: the group key id, a public commitment and the `foc/enc` format version ride
 * in data set metadata, every envelope names its own group key and salt, and the wallet
 * alone reads the data back.
 */

import {
  authorizationHeader,
  deriveGroupKey,
  COMMITMENT_KEY as GROUP_KEY_COMMITMENT_KEY,
  groupPath,
  keyForEnvelope,
  dataSetMetadata as keysmithDataSetMetadata,
  newSalt,
  type PieceMetadata,
  pieceKey,
  pieceMetadata,
  readPieceMetadata,
  rootClaim,
  type TypedDataSigner,
  type WriteTarget,
  writeTarget,
} from '@filoz/keysmith'
import type { Synapse } from '@filoz/synapse-sdk'
import type { KeyResolver } from 'filecoin-encryption-envelope'
import { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import { type Address, concat, type Hex, isAddress, keccak256, slice, toHex } from 'viem'
import { type DataSetSummary, listDataSets } from '../core/data-set/index.js'

/** A wallet that can sign for a group key (Keysmith's `GroupKey` message): the owner's own key, never a session key. */
export type OwnerSigner = TypedDataSigner & { address: Address }

/** The `login` command that gives a session key a group key Grant. */
export const GRANT_LOGIN_COMMAND = 'filecoin-pin login --scopes createDataSet,addPieces,encrypt'

export const OWNER_WALLET_REQUIRED = `Encrypted uploads need the owner wallet (set PRIVATE_KEY) or a session key with a group key Grant (run \`${GRANT_LOGIN_COMMAND}\`).`

/** The signing wallet behind a Synapse client; undefined for a session key or a read-only client. */
export function ownerSigner(synapse: Synapse): OwnerSigner | undefined {
  const account = synapse.client.account as Partial<OwnerSigner> | string | undefined
  return typeof account === 'object' && typeof account.signTypedData === 'function'
    ? (account as OwnerSigner)
    : undefined
}

/** Data set metadata key naming a data set's group key (Keysmith format 2). */
export const GROUP_KEY_ID_KEY = 'foc/gkid'

/** keysmith 0.1.0's group key id key: such data sets are encrypted, but this version cannot write to them. */
const LEGACY_GROUP_KEY_ID_KEY = 'foc/ks'

/**
 * A group path by keysmith's rules, canonical (`a/b`), checked before any signature or upload.
 *
 * @throws With keysmith's reason the path is refused.
 */
export function checkGroup(group: string): string {
  try {
    return groupPath(group)
  } catch (error) {
    throw new Error(`Invalid group "${group}": ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Data set metadata key that marks a data set as encrypted and versions its rules. */
export const ENCRYPTION_VERSION_KEY = 'foc/enc'

/** The only `foc/enc` value this version writes and reuses. */
export const ENCRYPTION_VERSION = '1'

/** Keys that mark a data set as encrypted; a plain upload never reuses a data set carrying any of them. */
export const ENCRYPTED_DATA_SET_KEYS: readonly string[] = [
  GROUP_KEY_ID_KEY,
  LEGACY_GROUP_KEY_ID_KEY,
  GROUP_KEY_COMMITMENT_KEY,
  ENCRYPTION_VERSION_KEY,
]

/** Data set metadata key for who may read its pieces. Absent: providers serve them on open paths. */
export const READ_KEY = 'read'

/** The only `read` value this version writes and reuses: pieces are served only on the authenticated path. */
export const READ_RESTRICTED = 'restricted'

/**
 * `read` is set only by `add --private`, never by `--data-set-metadata`, so no data set
 * is created with a visibility the upload did not choose (such as restricted plaintext).
 */
export function assertNoReadMetadata(dataSetMetadata: Record<string, string> | undefined): void {
  if (dataSetMetadata != null && READ_KEY in dataSetMetadata) {
    throw new Error(`--data-set-metadata cannot set ${READ_KEY}: use add --private for a private upload`)
  }
}

/** A data set's visibility, fixed at creation; the values are how `data-set show` and `list` print it. */
export type DataSetVisibility = 'public' | 'public encrypted' | 'private' | 'unknown visibility'

/** A data set's visibility from its metadata; any `read` other than `restricted` with `foc/enc` is unknown. */
export function dataSetVisibility(metadata: Record<string, string>): DataSetVisibility {
  if (READ_KEY in metadata) {
    return metadata[READ_KEY] === READ_RESTRICTED && ENCRYPTION_VERSION_KEY in metadata
      ? 'private'
      : 'unknown visibility'
  }
  return ENCRYPTED_DATA_SET_KEYS.some((key) => key in metadata) ? 'public encrypted' : 'public'
}

export interface OwnerGroupKey {
  /** Where new pieces are written: the group key itself, or a group within it. */
  target: WriteTarget
  /** `foc/enc`, `foc/gkid` and `foc/kc`, carried by every data set the upload writes to. */
  dataSetMetadata: Record<string, string>
}

/**
 * The id of an owner's first group key, so every client that sets one up before
 * any upload picks the same id:
 * `keccak256(utf8("filecoin/default-group-key") ‖ owner as 20 raw bytes)[0:16]`,
 * as 0x-prefixed lowercase hex. The owner address is case-insensitive.
 */
export function defaultGroupKeyId(owner: Address): Hex {
  if (!isAddress(owner, { strict: false })) throw new Error(`Not an address: ${owner}`)
  return slice(keccak256(concat([toHex('filecoin/default-group-key'), owner])), 0, 16)
}

/**
 * The group key this wallet encrypts under: the oldest valid one its data sets
 * record (see {@link oldestValidGroupKey}), else the owner's default one (see
 * {@link defaultGroupKeyId}). Every copy of an upload lands in data sets of this
 * one group key.
 *
 * `group`, already checked with {@link checkGroup}, writes under that group instead of the group key root.
 *
 * @throws If the recorded commitment does not match this wallet's key, or if the
 * default group key is already on chain but invalid.
 */
export async function ownerGroupKey(
  synapse: Synapse,
  signer: OwnerSigner,
  logger?: Logger,
  group?: string
): Promise<OwnerGroupKey> {
  const tagged = await listDataSets(synapse, {
    filter: (dataSet) => dataSet.isLive && typeof dataSet.metadata?.[GROUP_KEY_ID_KEY] === 'string',
    ...(logger != null && { logger }),
  })
  const recorded = oldestValidGroupKey(tagged, logger)
  const groupKeyId = recorded?.groupKeyId ?? defaultGroupKeyId(signer.address)
  if (recorded == null) {
    // The default id is on chain but its group was skipped: writing into it would grow an invalid group.
    const invalid = tagged.filter((dataSet) => dataSet.metadata?.[GROUP_KEY_ID_KEY] === groupKeyId)
    if (invalid.length > 0) {
      throw new Error(
        `The default group key ${groupKeyId} is already used by data sets ${invalid.map((d) => d.dataSetId).join(', ')}, which disagree on foc/kc or are not foc/enc "1"`
      )
    }
  }
  const ref = { owner: signer.address, groupKeyId }
  const keys = await deriveGroupKey(signer, ref, recorded == null ? {} : { commitment: recorded.commitment })
  const target = writeTarget(keys.descriptor, keys.groupKey, group)
  if (target.key !== keys.groupKey) keys.groupKey.fill(0)
  return { target, dataSetMetadata: encryptedDataSetMetadata(ref, keys.commitment) }
}

/** The metadata every encrypted data set of this group key carries: `foc/enc`, `foc/gkid` and `foc/kc`. */
export function encryptedDataSetMetadata(
  ref: { owner: Address; groupKeyId: Hex },
  commitment: string
): Record<string, string> {
  return { [ENCRYPTION_VERSION_KEY]: ENCRYPTION_VERSION, ...keysmithDataSetMetadata(ref, commitment) }
}

/**
 * A group key id as Keysmith and {@link defaultGroupKeyId} write it: 0x and 32 lowercase hex.
 * Ids are matched exactly, never case-folded, since data sets are reused by exact metadata.
 */
const CANONICAL_GROUP_KEY_ID = /^0x[0-9a-f]{32}$/

/**
 * "Oldest wins": sort data sets by their group key (`foc/gkid`), skip any group key
 * whose id is not canonical, whose data sets disagree on `foc/kc`, or that are not
 * all `foc/enc` "1", and return the remaining group key that holds the lowest data
 * set id.
 *
 * Inconsistent group keys are skipped rather than refused so that one bad group
 * key cannot block every encrypted upload; the skip is logged.
 */
export function oldestValidGroupKey(
  dataSets: DataSetSummary[],
  logger?: Logger
): { groupKeyId: Hex; commitment: string } | undefined {
  let best: { groupKeyId: Hex; commitment: string; oldest: bigint } | undefined
  for (const key of validGroupKeys(dataSets, logger)) {
    if (best == null || key.oldest < best.oldest) best = key
  }
  return best == null ? undefined : { groupKeyId: best.groupKeyId, commitment: best.commitment }
}

/**
 * Every group key {@link oldestValidGroupKey} would consider, with its commitment and its oldest
 * data set id; the skipped ones are logged.
 */
function validGroupKeys(
  dataSets: DataSetSummary[],
  logger?: Logger
): { groupKeyId: Hex; commitment: string; oldest: bigint }[] {
  const byGroupKey = new Map<string, DataSetSummary[]>()
  for (const dataSet of dataSets) {
    const groupKeyId = dataSet.metadata?.[GROUP_KEY_ID_KEY]
    if (typeof groupKeyId !== 'string') continue
    // Kept as written: a lookalike spelling is its own (skipped) group key, never merged into a canonical one.
    const members = byGroupKey.get(groupKeyId)
    if (members == null) byGroupKey.set(groupKeyId, [dataSet])
    else members.push(dataSet)
  }

  const valid: { groupKeyId: Hex; commitment: string; oldest: bigint }[] = []
  for (const [groupKeyId, members] of byGroupKey) {
    if (!CANONICAL_GROUP_KEY_ID.test(groupKeyId)) {
      logger?.warn(
        {
          event: 'group-key.skipped',
          groupKeyId,
          dataSetIds: members.map((dataSet) => dataSet.dataSetId.toString()),
        },
        'Skipping group key: its id is not 0x and 32 lowercase hex'
      )
      continue
    }
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
    valid.push({ groupKeyId: groupKeyId as Hex, commitment, oldest })
  }
  return valid
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
    appMetadata: pieceMetadata(target.ref, { salt, ...(target.group != null && { group: target.group }) }),
  }
}

/** The credentials hold no key for an envelope. Its message is safe to print as is. */
export class KeyAccessError extends Error {
  override name = 'KeyAccessError'
}

/**
 * The envelope's owner and group key (both public header labels), and what the
 * credentials hold instead (`held`), if anything.
 */
export class NotOwnerError extends KeyAccessError {
  override name = 'NotOwnerError'
  constructor(owner: string, groupKeyId: string, held: string | undefined) {
    super(
      held == null
        ? `This upload belongs to ${owner} under group key ${groupKeyId}; set PRIVATE_KEY to that wallet, or use a session key with a Grant for that group key (\`${GRANT_LOGIN_COMMAND}\`)`
        : `This upload belongs to ${owner} under group key ${groupKeyId}; ${held}`
    )
  }
}

/**
 * A FEE key resolver for the owner wallet: signs for the group key the envelope
 * names and derives the piece key from its labels. Signs twice, since there is
 * no data set commitment to check against offline.
 *
 * `signer` may be a getter, called only once an envelope needs a key, so callers that
 * may never meet one (`get` on plain content) need no credentials. A getter returning
 * undefined fails with a {@link NotOwnerError} naming the envelope's group key.
 */
export function ownerKeyResolver(signer: OwnerSigner | (() => OwnerSigner | undefined)): KeyResolver {
  return async ({ appMetadata }) => {
    const { owner, groupKeyId } = readPieceMetadata(appMetadata)
    const wallet = typeof signer === 'function' ? signer() : signer
    if (wallet == null || owner == null || owner.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new NotOwnerError(
        String(owner),
        groupKeyId,
        wallet == null
          ? undefined
          : `the owner wallet in use (PRIVATE_KEY or --private-key) is ${wallet.address.toLowerCase()}`
      )
    }
    const { groupKey } = await deriveGroupKey(wallet, { owner: wallet.address, groupKeyId })
    try {
      return keyForEnvelope(groupKey, appMetadata)
    } finally {
      groupKey.fill(0)
    }
  }
}

/** How long the owner's own read claims last: one `get` or `get-share-link` run. */
const OWNER_READ_CLAIM_SECONDS = 3600

/**
 * `Authorization` headers for the owner wallet to fetch one of its own private uploads from
 * `/download/<pieceCid>`. The piece's group key is inside the piece, so the wallet signs, for each
 * group key its read-restricted data sets record (`foc/gkid`), a root claim for that whole group
 * key with itself as bearer, valid for an hour; each request is signed fresh. The caller presents the
 * headers in turn while the provider answers 403. One wallet signature per group key, on first use.
 */
export function ownerAuthorizations(
  synapse: Synapse,
  signer: OwnerSigner,
  logger?: Logger
): (pieceCid: string) => Promise<string[]> {
  let chains: Promise<Awaited<ReturnType<typeof rootClaim>>['chain'][]> | undefined
  const issue = async () => {
    const restricted = await listDataSets(synapse, {
      filter: (dataSet) =>
        dataSet.isLive &&
        dataSet.metadata?.[READ_KEY] === READ_RESTRICTED &&
        typeof dataSet.metadata?.[GROUP_KEY_ID_KEY] === 'string',
      ...(logger != null && { logger }),
    })
    if (restricted.length === 0) {
      throw new Error(`Wallet ${signer.address} has no private data sets: nothing to fetch with --piece`)
    }
    // Each group key once, by oldestValidGroupKey's rule: one signature, checked against the commitment.
    // A group key that fails is skipped, so one bad data set cannot block every fetch.
    const expires = Math.floor(Date.now() / 1000) + OWNER_READ_CLAIM_SECONDS
    const issued = []
    for (const { groupKeyId, commitment } of validGroupKeys(restricted, logger)) {
      const ref = { owner: signer.address, groupKeyId }
      let groupKey: Uint8Array
      try {
        ;({ groupKey } = await deriveGroupKey(signer, ref, { commitment }))
      } catch (error) {
        logger?.warn(
          { event: 'group-key.skipped', groupKeyId, error: error instanceof Error ? error.message : String(error) },
          'Skipping group key: this wallet does not derive it'
        )
        continue
      }
      try {
        const { chain, nodeKey } = await rootClaim(signer, {
          ...ref,
          chainId: BigInt(synapse.chain.id),
          groupKey,
          node: 'groupKey',
          bearer: signer.address,
          maxDepth: 0,
          expires,
        })
        nodeKey.fill(0)
        issued.push(chain)
      } finally {
        groupKey.fill(0)
      }
    }
    if (issued.length === 0) {
      throw new Error(`None of wallet ${signer.address}'s private data sets has a group key it can read`)
    }
    return issued
  }
  return async (pieceCid) => {
    chains ??= issue()
    const piece = CID.parse(pieceCid).bytes
    return Promise.all((await chains).map((chain) => authorizationHeader(signer, chain, { pieceCid: piece })))
  }
}

/**
 * keysmith's refusal of keysmith 0.1.0 (format 1) data, if `error` or one of its causes is it: an
 * upload, Grant or share link from filecoin-pin 2.3 or 2.4, which this version no longer reads.
 * Callers show it as it is rather than a generic "not ours" or "corrupted".
 */
export function format1Message(error: unknown): string | undefined {
  for (let e = error; e instanceof Error; e = e.cause) {
    if (e.message.includes('keysmith 0.1.0 (format 1)')) return e.message
  }
  return undefined
}
