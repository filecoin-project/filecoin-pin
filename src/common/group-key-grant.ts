/**
 * Group key Grants: how a session key gets the owner's group key without the owner wallet.
 *
 * The owner approves the session key in the Filecoin Cloud console, which signs a Keysmith
 * root claim for the whole group key (`node: 'keyspace'`, bearer = the session key; by the
 * console's convention it expires with the session key's authorization), wraps the group key
 * to the session key's public key,
 * and shows the result as one line of text: `fgr1_` + base64url (no padding) of Keysmith's
 * `encodeDelivery(chain, grant)`. The CLI stores that text, never the key it opens.
 *
 * Keysmith's `openDelivery` checks the signatures, the expiry, that the session key is the
 * bearer, and the unwrapped key against the commitment the owner signed. It does not know
 * which owner, group key or network to expect, so {@link openGroupKeyGrant} checks those.
 */

import {
  type ClaimChain,
  decodeDelivery,
  COMMITMENT_KEY as GROUP_KEY_COMMITMENT_KEY,
  KEYSPACE_ID_KEY as GROUP_KEY_ID_KEY,
  type Grant,
  keyForEnvelope,
  openDelivery,
  publicKeyOf,
  writeTarget,
} from '@filoz/keysmith'
import type { Synapse } from '@filoz/synapse-sdk'
import type { KeyResolver } from 'filecoin-encryption-envelope'
import type { Logger } from 'pino'
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { listDataSets } from '../core/data-set/index.js'
import type { SynapseSetupConfig } from '../core/synapse/index.js'
import {
  ENCRYPTION_VERSION,
  ENCRYPTION_VERSION_KEY,
  GRANT_LOGIN_COMMAND,
  KeyAccessError,
  NotOwnerError,
  type OwnerGroupKey,
  ownerKeyResolver,
} from './group-key.js'

/** Text prefix of a Grant: names what the blob is. Keysmith's CBOR carries its own version. */
export const GRANT_PREFIX = 'fgr1_'

/** Text prefix of an Access key (a share link's other half), which users may paste by mistake. */
const ACCESS_KEY_PREFIX = 'fak1_'

/** The prefix the session key signs to bind its key-agreement public key to its address. */
const KEY_AGREEMENT_MESSAGE = 'Keysmith key agreement key: '

/** A Grant that failed a check. The message says why and is safe to print. */
export class GrantError extends KeyAccessError {
  override name = 'GrantError'
}

/** What an opened Grant gives a session key. The key never leaves the process. */
export interface OpenedGrant {
  /** The Grant text without whitespace, as stored. */
  text: string
  /** The group key id (`foc/ks`), lowercase. */
  groupKeyId: Hex
  /** The owner wallet that signed the Grant. */
  owner: Address
  /** Unix seconds after which the Grant no longer opens. */
  expires: number
  /** `foc/kc` for new data sets: the commitment the owner signed, in metadata form. */
  commitment: string
  grant: Grant
  /** The Grant's claim chain, which a share link delegates from. */
  chain: ClaimChain
  /** The group key itself. */
  key: Uint8Array
}

export interface GrantExpectations {
  /** The session key the Grant must be wrapped to. */
  sessionKey: Hex
  /** The wallet that authorized the session key (`WALLET_ADDRESS`). */
  walletAddress: string
  /** The session's chain id; undefined skips the check (an offline read with only `--rpc-url`). */
  chainId?: number | undefined
  /** `GROUP_KEY_ID`, when loading a saved Grant. */
  groupKeyId?: string | undefined
  /** Unix seconds, for tests. */
  now?: number | undefined
}

/** The Grant text as pasted, minus every whitespace character: consoles and terminals wrap long lines. */
export function normalizeGrantText(text: string): string {
  return text.replace(/\s+/g, '')
}

/** The text form of a Keysmith delivery. */
export function grantText(delivery: Uint8Array): string {
  return `${GRANT_PREFIX}${Buffer.from(delivery).toString('base64url')}`
}

/**
 * `pubkey` and `pubkeysig` for the console link: the session key's Keysmith key-agreement
 * public key, and the session key's EIP-191 signature binding it to the session address.
 */
export async function keyAgreementParams(sessionKey: Hex): Promise<{ pubkey: Hex; pubkeysig: Hex }> {
  const pubkey = publicKeyOf(sessionKey).toLowerCase() as Hex
  const pubkeysig = await privateKeyToAccount(sessionKey).signMessage({
    message: `${KEY_AGREEMENT_MESSAGE}${pubkey}`,
  })
  return { pubkey, pubkeysig }
}

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** The Grant's bytes, or a GrantError naming what the text looks like instead. */
function grantBytes(text: string): Uint8Array {
  if (text === '') throw new GrantError('No Grant given.')
  if (!text.startsWith(GRANT_PREFIX)) {
    if (text.startsWith(ACCESS_KEY_PREFIX)) {
      throw new GrantError(`This is an Access key, not a Grant. A Grant starts with ${GRANT_PREFIX}.`)
    }
    if (text.includes('#v1/') || /https?:/i.test(text)) {
      throw new GrantError(`This is a share link, not a Grant. A Grant starts with ${GRANT_PREFIX}.`)
    }
    throw new GrantError(`This is not a Grant: a Grant starts with ${GRANT_PREFIX}.`)
  }
  const body = text.slice(GRANT_PREFIX.length)
  if (body === '') throw incomplete()
  if (!/^[A-Za-z0-9_-]+$/.test(body)) {
    throw new GrantError(
      'This is not a Grant: it contains characters a Grant never has. Copy it again from the console.'
    )
  }
  return new Uint8Array(Buffer.from(body, 'base64url'))
}

const incomplete = (): GrantError =>
  new GrantError('The Grant is incomplete or corrupted; copy it again from the console.')

/**
 * Decode a Grant's text without verifying it: the prefix, the base64url and the CBOR.
 *
 * @throws GrantError naming what the text is instead, or that it is incomplete.
 */
export function decodeGrantText(rawText: string): {
  text: string
  bytes: Uint8Array
  delivery: ReturnType<typeof decodeDelivery>
} {
  const text = normalizeGrantText(rawText)
  const bytes = grantBytes(text)
  try {
    return { text, bytes, delivery: decodeDelivery(bytes) }
  } catch {
    throw incomplete()
  }
}

/**
 * The checks that need neither the owner nor the network, so `login` can run them before it
 * waits for the authorization: the Grant decodes, names this session key as its bearer, and
 * has not expired. Unverified: {@link openGroupKeyGrant} checks them all again with the
 * signatures.
 *
 * @throws GrantError with the reason it is refused.
 */
export function precheckGroupKeyGrant(
  rawText: string,
  sessionKey: Hex,
  now: number = Math.floor(Date.now() / 1000)
): void {
  const { delivery } = decodeGrantText(rawText)
  const sessionAddress = privateKeyToAccount(sessionKey).address
  const bearer = delivery.chain.links.at(-1)?.bearer
  if (bearer != null && !sameAddress(bearer, sessionAddress)) {
    throw new GrantError(`This Grant is for another session key (${bearer}), not this one (${sessionAddress}).`)
  }
  if (delivery.chain.expires <= now) {
    throw new GrantError(`This Grant expired at ${new Date(delivery.chain.expires * 1000).toISOString()}.`)
  }
}

/**
 * Open a Grant for this session key and check it is for this owner, network and group key.
 * Grant checks come before key checks, so each refusal names its own reason.
 *
 * @throws GrantError with the reason it is refused.
 */
export async function openGroupKeyGrant(rawText: string, expected: GrantExpectations): Promise<OpenedGrant> {
  const { text, bytes } = decodeGrantText(rawText)
  const now = expected.now ?? Math.floor(Date.now() / 1000)
  precheckGroupKeyGrant(text, expected.sessionKey, now)

  let opened: Awaited<ReturnType<typeof openDelivery>>
  try {
    opened = await openDelivery(expected.sessionKey, bytes, { now })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new GrantError(`The Grant does not verify (${reason}); copy it again from the console.`)
  }
  const { claim, grant, key, chain } = opened

  if (!sameAddress(claim.owner, expected.walletAddress)) {
    throw new GrantError(
      `This Grant is from wallet ${claim.owner}, not ${expected.walletAddress}, which authorized this session key.`
    )
  }
  if (expected.chainId != null && claim.chainId !== BigInt(expected.chainId)) {
    throw new GrantError(`This Grant is for another network (chain id ${claim.chainId}, not ${expected.chainId}).`)
  }
  if (claim.node !== 'keyspace') {
    throw new GrantError(`This Grant covers ${claim.node}, not a whole group key, which this version needs.`)
  }
  if (expected.groupKeyId != null && claim.keyspace !== expected.groupKeyId.toLowerCase()) {
    throw new GrantError(`This Grant is for group key ${claim.keyspace}, but GROUP_KEY_ID is ${expected.groupKeyId}.`)
  }
  return {
    text,
    groupKeyId: claim.keyspace,
    owner: claim.owner,
    expires: claim.expires,
    // The claim carries `0x<32 hex>`; data set metadata records `v1.<32 hex>`.
    commitment: `v1.${claim.keyspaceCommitment.slice(2)}`,
    grant,
    chain,
    key,
  }
}

/** Session credentials as `parseCLIAuth` resolves them. */
export interface SessionCredentials {
  sessionKey: Hex
  walletAddress: string
}

/**
 * Open the Grant the credential sources supplied (`GROUP_KEY_GRANT` and `GROUP_KEY_ID`, from
 * the environment, `--credentials-file` or the saved login).
 *
 * @throws GrantError saying the Grant is missing or why it is ignored, with the login to run.
 */
export async function loadGroupKeyGrant(
  session: SessionCredentials,
  chainId: number | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<OpenedGrant> {
  const text = env.GROUP_KEY_GRANT
  const groupKeyId = env.GROUP_KEY_ID
  if (text == null || text === '') {
    throw new GrantError(`This session key has no group key Grant. Run \`${GRANT_LOGIN_COMMAND}\` to get one.`)
  }
  if (groupKeyId == null || groupKeyId === '') {
    throw new GrantError(`GROUP_KEY_GRANT is set without GROUP_KEY_ID. Set both, or run \`${GRANT_LOGIN_COMMAND}\`.`)
  }
  try {
    return await openGroupKeyGrant(text, { ...session, chainId, groupKeyId })
  } catch (error) {
    if (!(error instanceof GrantError)) throw error
    throw new GrantError(
      `The Grant in GROUP_KEY_GRANT was ignored: ${error.message} Run \`${GRANT_LOGIN_COMMAND}\` to get a new one (unset GROUP_KEY_GRANT if it is exported in this shell).`
    )
  }
}

/**
 * Where a session key writes: the Grant's group key, tagged with the commitment the owner
 * signed. Refuses a group key whose live data sets record another commitment or another
 * `foc/enc`: the Grant and the chain must agree before anything is written.
 */
export async function grantGroupKey(synapse: Synapse, opened: OpenedGrant, logger?: Logger): Promise<OwnerGroupKey> {
  const members = await listDataSets(synapse, {
    // Exact match, as in oldestValidGroupKey: a non-canonical lookalike id is another group, ignored.
    filter: (dataSet) => dataSet.isLive && dataSet.metadata?.[GROUP_KEY_ID_KEY] === opened.groupKeyId,
    ...(logger != null && { logger }),
  })
  const disagreeing = members.filter(
    (dataSet) =>
      dataSet.metadata?.[GROUP_KEY_COMMITMENT_KEY] !== opened.commitment ||
      dataSet.metadata?.[ENCRYPTION_VERSION_KEY] !== ENCRYPTION_VERSION
  )
  if (disagreeing.length > 0) {
    throw new GrantError(
      `Group key ${opened.groupKeyId} is used by data sets ${disagreeing.map((d) => d.dataSetId).join(', ')}, which disagree with the Grant on foc/kc or are not foc/enc "1".`
    )
  }
  const target = writeTarget(opened.grant, opened.key)
  // The caller zeroes target.key once used; a copy leaves the opened key to zero here.
  if (target.key !== opened.key) opened.key.fill(0)
  return {
    target,
    dataSetMetadata: {
      [ENCRYPTION_VERSION_KEY]: ENCRYPTION_VERSION,
      [GROUP_KEY_ID_KEY]: opened.groupKeyId,
      [GROUP_KEY_COMMITMENT_KEY]: opened.commitment,
    },
  }
}

/**
 * A FEE key resolver for a session key's Grant. `load` runs only when an envelope needs a
 * key, so plain content needs no Grant, and the group key it opens is zeroed once the piece
 * key is derived. An envelope of another owner or group key fails with a
 * {@link NotOwnerError} naming both.
 */
export function grantKeyResolver(load: () => Promise<OpenedGrant>): KeyResolver {
  return async ({ appMetadata }) => {
    const groupKeyId = appMetadata?.['foc/ks']
    if (appMetadata?.['foc/v'] !== 1 || typeof groupKeyId !== 'string') {
      throw new Error('not a Keysmith envelope')
    }
    const opened = await load()
    try {
      const owner = appMetadata['foc/own']
      if (
        typeof owner !== 'string' ||
        !sameAddress(owner, opened.owner) ||
        groupKeyId.toLowerCase() !== opened.groupKeyId
      ) {
        throw new NotOwnerError(
          String(owner),
          groupKeyId,
          `this session's Grant is for group key ${opened.groupKeyId} of ${opened.owner.toLowerCase()}`
        )
      }
      return keyForEnvelope(opened.key, appMetadata, opened.grant)
    } finally {
      opened.key.fill(0)
    }
  }
}

/**
 * The key resolver for the CLI credentials: the owner wallet (`PRIVATE_KEY`), else a session
 * key's Grant. With neither, an envelope fails with a {@link NotOwnerError} naming its group
 * key. Nothing is signed or opened until an envelope needs a key.
 */
export function credentialKeyResolver(auth: SynapseSetupConfig): KeyResolver {
  if ('privateKey' in auth && auth.privateKey != null) return ownerKeyResolver(privateKeyToAccount(auth.privateKey))
  if ('sessionKey' in auth && auth.sessionKey != null) {
    const session = { sessionKey: auth.sessionKey, walletAddress: auth.walletAddress }
    return grantKeyResolver(() => loadGroupKeyGrant(session, auth.chain?.id))
  }
  return ownerKeyResolver(() => undefined)
}
