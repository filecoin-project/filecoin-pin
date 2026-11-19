/**
 * Group key Grants: how a session key gets the owner's group key, or a group within it,
 * without the owner wallet.
 *
 * The owner approves the session key in the Filecoin Cloud console, which signs a Keysmith
 * root claim for the whole group key (`node: 'groupKey'`) or for one group (`group:<path>`),
 * bearer = the session key (by the console's convention it expires with the session key's
 * authorization), wraps that node's key to the session key's public key, and shows the result
 * as one line of text: `fgr1_` + base64url (no padding) of Keysmith's
 * `encodeDelivery(chain, grant)`. The CLI stores that text, never the key it opens.
 *
 * A session key may hold several Grants of one group key, for disjoint groups. They are stored
 * together, comma-separated, in `GROUP_KEY_GRANT`. Keysmith's `pickGrant` chooses the narrowest
 * one that reaches what is read or written.
 *
 * Keysmith's `openDelivery` checks the signatures, the expiry, that the session key is the
 * bearer, and the unwrapped key against the commitment the owner signed. It does not know
 * which owner, group key or network to expect, so {@link openGroupKeyGrant} checks those.
 */

import {
  authorizationHeader,
  type ClaimChain,
  decodeDelivery,
  COMMITMENT_KEY as GROUP_KEY_COMMITMENT_KEY,
  type Grant,
  keyForEnvelope,
  openDelivery,
  type PieceLabels,
  pickGrant,
  publicKeyOf,
  readPieceMetadata,
  type VerifiedClaim,
  writeTarget,
} from '@filoz/keysmith'
import type { Synapse } from '@filoz/synapse-sdk'
import type { KeyResolver } from 'filecoin-encryption-envelope'
import { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { listDataSets } from '../core/data-set/index.js'
import type { SynapseSetupConfig } from '../core/synapse/index.js'
import { log } from '../utils/cli-logger.js'
import {
  ENCRYPTION_VERSION,
  ENCRYPTION_VERSION_KEY,
  encryptedDataSetMetadata,
  format1Message,
  GRANT_LOGIN_COMMAND,
  GROUP_KEY_ID_KEY,
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
  /** The group key id (`foc/gkid`), lowercase. */
  groupKeyId: Hex
  /** The group the Grant covers, with every group beneath it; undefined for the whole group key. */
  group?: string
  /** The verified final claim, as Keysmith's `pickGrant` reads it. */
  claim: VerifiedClaim
  /** The claim chain, for the `Authorization` header on the authenticated path. */
  chain: ClaimChain
  /** The owner wallet that signed the Grant. */
  owner: Address
  /** Unix seconds after which the Grant no longer opens. */
  expires: number
  /** `foc/kc` for new data sets: the commitment the owner signed, in metadata form. */
  commitment: string
  grant: Grant
  /** The key of the Grant's node: the group key, or its group's key. */
  key: Uint8Array
}

/** What a Grant covers, for messages: `group key 0x…` or `group a/b of group key 0x…`. */
export function grantCovers(opened: Pick<OpenedGrant, 'group' | 'groupKeyId'>): string {
  return opened.group == null
    ? `group key ${opened.groupKeyId}`
    : `group ${opened.group} of group key ${opened.groupKeyId}`
}

/** Separator between Grants in `GROUP_KEY_GRANT`: base64url never contains it. */
const GRANT_SEPARATOR = ','

/** The stored form of several Grants. */
export function joinGrants(texts: readonly string[]): string {
  return texts.join(GRANT_SEPARATOR)
}

/** The Grants in a stored `GROUP_KEY_GRANT`, empty entries dropped. */
export function splitGrants(text: string): string[] {
  return text
    .split(GRANT_SEPARATOR)
    .map(normalizeGrantText)
    .filter((t) => t !== '')
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
  } catch (error) {
    // A Grant from filecoin-pin 2.3 or 2.4 (keysmith 0.1.0) is whole, just in a format this version no longer reads.
    const format1 = format1Message(error)
    if (format1 != null) throw new GrantError(`${format1} Get a new Grant: run \`${GRANT_LOGIN_COMMAND}\`.`)
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
  const { claim, grant, key } = opened

  if (!sameAddress(claim.owner, expected.walletAddress)) {
    throw new GrantError(
      `This Grant is from wallet ${claim.owner}, not ${expected.walletAddress}, which authorized this session key.`
    )
  }
  if (expected.chainId != null && claim.chainId !== BigInt(expected.chainId)) {
    throw new GrantError(`This Grant is for another network (chain id ${claim.chainId}, not ${expected.chainId}).`)
  }
  if (expected.groupKeyId != null && claim.groupKeyId !== expected.groupKeyId.toLowerCase()) {
    throw new GrantError(`This Grant is for group key ${claim.groupKeyId}, but GROUP_KEY_ID is ${expected.groupKeyId}.`)
  }
  let group: string | undefined
  if (claim.node.startsWith('group:')) group = claim.node.slice('group:'.length)
  else if (claim.node !== 'groupKey') {
    // A piece Grant opens one existing piece: it can neither write nor read a group.
    throw new GrantError(`This Grant covers ${claim.node}, not a group key or a group, which login needs.`)
  }
  return {
    text,
    groupKeyId: claim.groupKeyId,
    ...(group != null && { group }),
    claim,
    chain: opened.chain,
    owner: claim.owner,
    expires: claim.expires,
    // The claim carries `0x<32 hex>`; data set metadata records `v2.<32 hex>`.
    commitment: `v2.${claim.groupKeyCommitment.slice(2)}`,
    grant,
    key,
  }
}

/** Session credentials as `parseCLIAuth` resolves them. */
export interface SessionCredentials {
  sessionKey: Hex
  walletAddress: string
}

/**
 * Open every Grant the credential sources supplied (`GROUP_KEY_GRANT`, comma-separated, and
 * `GROUP_KEY_ID`, from the environment, `--credentials-file` or the saved login).
 *
 * @throws GrantError saying the Grants are missing or why one is ignored, with the login to run.
 */
export async function loadGroupKeyGrants(
  session: SessionCredentials,
  chainId: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => log.warn(message)
): Promise<OpenedGrant[]> {
  const texts = splitGrants(env.GROUP_KEY_GRANT ?? '')
  const groupKeyId = env.GROUP_KEY_ID
  if (texts.length === 0) {
    throw new GrantError(`This session key has no group key Grant. Run \`${GRANT_LOGIN_COMMAND}\` to get one.`)
  }
  if (groupKeyId == null || groupKeyId === '') {
    throw new GrantError(`GROUP_KEY_GRANT is set without GROUP_KEY_ID. Set both, or run \`${GRANT_LOGIN_COMMAND}\`.`)
  }
  // A Grant that no longer opens (one group's Grant expired, say) is skipped with a warning, as login drops it;
  // the others still work. Only when none opens is that an error.
  const opened: OpenedGrant[] = []
  const ignored: string[] = []
  for (const text of texts) {
    try {
      opened.push(await openGroupKeyGrant(text, { ...session, chainId, groupKeyId }))
    } catch (error) {
      if (!(error instanceof GrantError)) {
        for (const o of opened) o.key.fill(0)
        throw error
      }
      ignored.push(error.message)
    }
  }
  const relogin = `Run \`${GRANT_LOGIN_COMMAND}\` to get a new one (unset GROUP_KEY_GRANT if it is exported in this shell).`
  if (opened.length === 0) {
    throw new GrantError(`The Grant in GROUP_KEY_GRANT was ignored: ${ignored.join(' ')} ${relogin}`)
  }
  for (const reason of ignored) warn(`A Grant in GROUP_KEY_GRANT was ignored: ${reason} ${relogin}`)
  return opened
}

/**
 * `Authorization` headers for one gated `/download/<pieceCid>`, one per held Grant: its claim chain
 * plus a read request for that piece, signed by the session key (the chain's bearer). The whole group
 * key's Grant comes first, since it reaches every piece; a group Grant reaches only its group's, and
 * the piece's group is inside the piece, so the caller tries them in turn. Make them per request: each
 * expires within the gate's 5-minute limit. The keys the Grants open never leave this function.
 */
export async function grantAuthorizations(
  session: SessionCredentials,
  chainId: number | undefined,
  pieceCid: string
): Promise<string[]> {
  const grants = await loadGroupKeyGrants(session, chainId)
  for (const g of grants) g.key.fill(0)
  const ordered = [...grants.filter((g) => g.group == null), ...grants.filter((g) => g.group != null)]
  const bearer = privateKeyToAccount(session.sessionKey)
  const piece = CID.parse(pieceCid).bytes
  return Promise.all(ordered.map((g) => authorizationHeader(bearer, g.chain, { pieceCid: piece })))
}

/** The command that asks for a Grant to `group`. */
const groupLoginCommand = (group: string): string => `${GRANT_LOGIN_COMMAND} --group ${group}`

/**
 * The Grant a session key writes `group` with (undefined: the Grant's own group): the narrowest
 * one that covers it. With no group named and several Grants, the whole group key's Grant if held,
 * else the caller must choose.
 *
 * @throws GrantError when no Grant covers the group, or the choice is ambiguous.
 */
export function grantForWrite(grants: readonly OpenedGrant[], group: string | undefined): OpenedGrant {
  const [first] = grants
  if (first == null) throw new GrantError(`This session key has no group key Grant. Run \`${GRANT_LOGIN_COMMAND}\`.`)
  if (group == null) {
    if (grants.length === 1) return first
    const whole = grants.find((g) => g.group == null)
    if (whole != null) return whole
    throw new GrantError(
      `This session key holds Grants for several groups (${grants.map((g) => g.group).join(', ')}): choose one with --group.`
    )
  }
  const picked = pickGrant(
    grants,
    { owner: first.owner, groupKeyId: first.groupKeyId, group },
    { chainId: first.claim.chainId }
  )
  if (picked == null) {
    throw new GrantError(
      `None of this session key's Grants covers group ${group} (held: ${grants.map(grantCovers).join('; ')}). Run \`${groupLoginCommand(group)}\`.`
    )
  }
  return picked
}

/**
 * Where a session key writes: `group` (default: the chosen Grant's own group) of the Grant's
 * group key, tagged with the commitment the owner signed. Refuses a group no Grant covers, and
 * a group key whose live data sets record another commitment or another `foc/enc`: the Grant
 * and the chain must agree before anything is written. Every Grant's key is zeroed.
 */
export async function grantGroupKey(
  synapse: Synapse,
  grants: readonly OpenedGrant[],
  group: string | undefined,
  logger?: Logger
): Promise<OwnerGroupKey> {
  try {
    return await writeWith(synapse, grantForWrite(grants, group), group, logger)
  } finally {
    for (const g of grants) g.key.fill(0)
  }
}

async function writeWith(
  synapse: Synapse,
  opened: OpenedGrant,
  group: string | undefined,
  logger?: Logger
): Promise<OwnerGroupKey> {
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
  // writeTarget walks a copy when the group is below the Grant's: the caller zeroes target.key once used.
  const target = writeTarget(opened.grant, opened.key, group)
  if (target.key === opened.key) target.key = opened.key.slice()
  return { target, dataSetMetadata: encryptedDataSetMetadata(opened, opened.commitment) }
}

/**
 * The Grant that opens a piece with these envelope labels: Keysmith's `pickGrant`, the narrowest
 * one that reaches the piece's group.
 *
 * @throws NotOwnerError for another owner or group key; GrantError when the piece is outside
 * every held group.
 */
export function grantForPiece(grants: readonly OpenedGrant[], appMetadata: unknown): OpenedGrant {
  const labels = readPieceMetadata(appMetadata as Record<string, unknown>)
  const [first] = grants
  if (first == null) throw new GrantError(`This session key has no group key Grant. Run \`${GRANT_LOGIN_COMMAND}\`.`)
  const owner = labels.owner ?? first.owner
  if (!sameAddress(owner, first.owner) || labels.groupKeyId !== first.groupKeyId) {
    throw new NotOwnerError(
      owner,
      labels.groupKeyId,
      `this session's Grants are for group key ${first.groupKeyId} of ${first.owner.toLowerCase()}`
    )
  }
  const picked = pickGrant(
    grants,
    { piece: appMetadata as PieceLabels },
    {
      chainId: first.claim.chainId,
      owner: first.owner,
    }
  )
  if (picked == null) {
    const where = labels.group == null ? 'at the group key root (no group)' : `in group ${labels.group}`
    throw new GrantError(
      `This upload is ${where}, outside every group this session key holds a Grant for (${grants.map(grantCovers).join('; ')}).${labels.group == null ? '' : ` Run \`${groupLoginCommand(labels.group)}\` for a Grant that covers it.`}`
    )
  }
  return picked
}

/**
 * A FEE key resolver for a session key's Grants. `load` runs only when an envelope needs a
 * key, so plain content needs no Grant, and every key it opens is zeroed once the piece key
 * is derived. An envelope of another owner or group key fails with a {@link NotOwnerError}
 * naming both; one outside every held group, with a GrantError naming the login to run.
 */
export function grantKeyResolver(load: () => Promise<OpenedGrant[]>): KeyResolver {
  return async ({ appMetadata }) => {
    // Refuses anything but a format 2 Keysmith envelope before a Grant is opened.
    readPieceMetadata(appMetadata)
    const grants = await load()
    try {
      const picked = grantForPiece(grants, appMetadata)
      return keyForEnvelope(picked.key, appMetadata, picked.grant)
    } finally {
      for (const g of grants) g.key.fill(0)
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
    return grantKeyResolver(() => loadGroupKeyGrants(session, auth.chain?.id))
  }
  return ownerKeyResolver(() => undefined)
}
