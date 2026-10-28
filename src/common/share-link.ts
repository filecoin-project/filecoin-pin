/**
 * Share links (#779): one encrypted upload, shared with someone who has no key pair.
 *
 * A share is a Keysmith payload wrapped to a throwaway key T that the sender makes for the
 * recipient. Nothing flows back from the recipient, so it works for anyone on the web:
 *
 * - a **delivery** (a `piece:<salt>` claim for T plus the wrapped piece key) when the sender
 *   can issue a claim: the owner wallet, or a session key whose Grant allows re-sharing;
 * - a plain **piece grant** from a session key whose Grant cannot be re-shared (`maxDepth: 0`).
 *   It decrypts, but carries no claim, so it cannot fetch from providers that gate retrieval.
 *
 * T's private key reaches the recipient as an Access key sent separately (the default), inside
 * the link (`--restricted`), or derived from a password (`--password`, Keysmith's `pw1`):
 *
 *   <viewer>#v1/<encrypted root CID>&d=<payload>[&k=fak1_<key> | &p=pw1.<salt>]
 *
 * Every value is base64url without padding. Everything is in the fragment, so nothing reaches a
 * server. Every link has its own T, so links are independent.
 */

import {
  decodeGrant,
  delegateClaim,
  keyspaceKeys as deriveGroupKey,
  encodeDelivery,
  encodeGrant,
  type Grant,
  grantDescriptor,
  keyForEnvelope,
  openDelivery,
  type PieceMetadata,
  pieceNode,
  publicKeyOf,
  rootClaim,
  shareKeyFromPassword,
  unwrapWith,
  wrapTo,
} from '@filoz/keysmith'
import type { KeyResolver } from 'filecoin-encryption-envelope'
import { CID } from 'multiformats/cid'
import { bytesToHex, type Hex, hexToBytes } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { KeyAccessError, type OwnerSigner } from './group-key.js'
import { GRANT_PREFIX, type OpenedGrant } from './group-key-grant.js'

/**
 * The share viewer the links open in.
 * TODO(FilOzone/synapse-sdk#1036): the v1 viewer's published URL. Until it ships this is the
 * prototype, which shows the link's shape but cannot open v1 shares.
 */
export const DEFAULT_VIEWER_URL =
  'https://bafkreierah7bnqa4ah5gahnepajuqh3l5etmysc63zqzfegqwlez2deonm.ipfs.inbrowser.link/'

/** Prefix of an Access key's text form: lets both sides refuse a wrong paste, and secret scanners find a leak. */
export const ACCESS_KEY_PREFIX = 'fak1_'

/** Prefix of a password share's salt in the link: the `pw1` derivation, whose parameters it fixes. */
export const PASSWORD_PREFIX = 'pw1.'

/** Shortest password accepted for `--password`: anyone holding the link can guess offline. */
export const MIN_PASSWORD_LENGTH = 12

export type ShareMode = 'access-key' | 'password' | 'restricted'

/** How the recipient gets T's private key, as the link records it. */
export type ShareSecret = { kind: 'access-key'; key: Hex } | { kind: 'password'; salt: Uint8Array }

export interface ParsedShare {
  rootCid: CID
  /** A Keysmith delivery or a plain grant, told apart by CBOR shape (array or map). */
  payload: Uint8Array
  /** In the link itself: the Access key (restricted) or the password salt. Absent by default. */
  secret?: ShareSecret
}

/** A share link, or an Access key, that cannot be used. The message is safe to print. */
export class ShareLinkError extends KeyAccessError {
  override name = 'ShareLinkError'
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

function unb64(text: string, what: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new ShareLinkError(`${what} is not base64url; copy the link again`)
  return new Uint8Array(Buffer.from(text, 'base64url'))
}

/** The text form of an Access key: `fak1_` + base64url of the 32-byte private key. */
export function accessKeyText(key: Hex): string {
  return `${ACCESS_KEY_PREFIX}${b64(hexToBytes(key))}`
}

/** Read an Access key, refusing a Grant or a Share link pasted in its place with a clear error. */
export function parseAccessKey(text: string): Hex {
  const clean = text.replace(/\s+/g, '')
  if (clean.startsWith(GRANT_PREFIX)) {
    throw new ShareLinkError('That is a group key Grant (fgr1_…), not an Access key (fak1_…)')
  }
  if (clean.includes('#v1/')) throw new ShareLinkError('That is a Share link, not an Access key (fak1_…)')
  if (!clean.startsWith(ACCESS_KEY_PREFIX)) throw new ShareLinkError('An Access key starts with fak1_')
  const bytes = unb64(clean.slice(ACCESS_KEY_PREFIX.length), 'The Access key')
  if (bytes.length !== 32) throw new ShareLinkError('The Access key is incomplete; copy it again')
  return bytesToHex(bytes)
}

/** `<viewer>#v1/<rootCid>&d=<payload>`, then `&k=` for a restricted link or `&p=` for a password share. */
export function formatShareLink(viewer: string, rootCid: CID, payload: Uint8Array, secret?: ShareSecret): string {
  const base = viewer.split('#')[0] ?? viewer
  let fragment = `v1/${rootCid.toString()}&d=${b64(payload)}`
  if (secret?.kind === 'access-key') fragment += `&k=${accessKeyText(secret.key)}`
  if (secret?.kind === 'password') fragment += `&p=${PASSWORD_PREFIX}${b64(secret.salt)}`
  return `${base}#${fragment}`
}

/** Read a Share link, refusing an Access key or a Grant pasted in its place with a clear error. */
export function parseShareLink(text: string): ParsedShare {
  const clean = text.replace(/\s+/g, '')
  if (clean.startsWith(ACCESS_KEY_PREFIX)) throw new ShareLinkError('That is an Access key, not a Share link')
  if (clean.startsWith(GRANT_PREFIX)) throw new ShareLinkError('That is a group key Grant (fgr1_…), not a Share link')
  const fragment = clean.slice(clean.indexOf('#') + 1)
  if (!clean.includes('#') || !fragment.startsWith('v1/')) {
    throw new ShareLinkError('Not a v1 Share link: expected <viewer>#v1/<CID>&d=…')
  }
  const [cidText, ...params] = fragment.slice('v1/'.length).split('&')
  let rootCid: CID
  try {
    rootCid = CID.parse(cidText ?? '')
  } catch {
    throw new ShareLinkError('The Share link names no valid CID; copy it again')
  }
  const values = new Map<string, string>()
  for (const param of params) {
    const at = param.indexOf('=')
    const name = at < 0 ? param : param.slice(0, at)
    if (!['d', 'k', 'p'].includes(name) || values.has(name)) {
      throw new ShareLinkError(`The Share link has an unexpected part "${name}"; copy it again`)
    }
    values.set(name, param.slice(at + 1))
  }
  const d = values.get('d')
  if (d == null || d === '') throw new ShareLinkError('The Share link is incomplete (no share in it); copy it again')
  const k = values.get('k')
  const p = values.get('p')
  if (k != null && p != null) throw new ShareLinkError('The Share link carries both a key and a password salt')
  let secret: ShareSecret | undefined
  if (k != null) secret = { kind: 'access-key', key: parseAccessKey(k) }
  if (p != null) {
    if (!p.startsWith(PASSWORD_PREFIX)) throw new ShareLinkError('The Share link uses an unknown password scheme')
    const salt = unb64(p.slice(PASSWORD_PREFIX.length), 'The password salt')
    if (salt.length !== 16) throw new ShareLinkError('The password salt is incomplete; copy the link again')
    secret = { kind: 'password', salt }
  }
  return { rootCid, payload: unb64(d, 'The share'), ...(secret != null && { secret }) }
}

/** A generated password: 20 random base32 characters in groups of 5, about 100 bits. */
export function generatePassword(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  const chars = Array.from(crypto.getRandomValues(new Uint8Array(20)), (byte) => alphabet[byte % 32])
  return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join('')).join('-')
}

/** Who shares: the owner wallet, or a session key with its opened group key Grant. */
export type ShareSender = { owner: OwnerSigner } | { sessionKey: Hex; grant: OpenedGrant }

export interface CreateShareInput {
  sender: ShareSender
  rootCid: CID
  /** The upload's envelope labels (`appMetadata`): they name its group key, owner and salt. */
  labels: PieceMetadata
  /** The upload's piece CID, carried as the claim's locator so a recipient knows what to request. */
  pieceCid?: CID
  chainId: number
  mode: ShareMode
  /** For `password` mode; generated when absent. */
  password?: string
  /** Unix seconds; owner mode only (a session key's share lasts as long as its Grant). */
  expires: number
  viewer?: string
}

export interface CreatedShare {
  link: string
  /** The Access key to send separately (default mode only). */
  accessKey?: string
  /** The generated password, if the caller gave none (password mode only). */
  password?: string
  /** `delivery` fetches from gating providers too; a plain `grant` only decrypts. */
  payloadKind: 'delivery' | 'grant'
  /** When the share stops fetching from gating providers; absent for a plain grant. */
  expires?: number
}

/**
 * Mint a share link for one upload, wrapped to a fresh key T (or one derived from a password).
 *
 * @throws If the sender holds no key for the upload, or a supplied password is too short.
 */
export async function createShare(input: CreateShareInput): Promise<CreatedShare> {
  const { labels, sender } = input
  const ref = { owner: labels['foc/own'], keyspace: labels['foc/ks'] }
  const node = pieceNode(labels)
  const pieceCid = input.pieceCid?.bytes

  let password: string | undefined
  let salt: Uint8Array | undefined
  let T: Hex
  if (input.mode === 'password') {
    password = input.password ?? generatePassword()
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new ShareLinkError(`A share password needs at least ${MIN_PASSWORD_LENGTH} characters`)
    }
    salt = crypto.getRandomValues(new Uint8Array(16))
    T = await shareKeyFromPassword(password, salt)
  } else {
    T = generatePrivateKey()
  }
  const bearer = privateKeyToAccount(T).address
  const descriptor = grantDescriptor(ref, node)

  let payload: Uint8Array
  let payloadKind: CreatedShare['payloadKind']
  let expires: number | undefined
  if ('owner' in sender) {
    if (labels['foc/own'].toLowerCase() !== sender.owner.address.toLowerCase()) {
      throw new ShareLinkError(`This upload belongs to ${labels['foc/own']}, not ${sender.owner.address.toLowerCase()}`)
    }
    const { kk } = await deriveGroupKey(sender.owner, ref)
    try {
      const claim = await rootClaim(sender.owner, {
        ...ref,
        chainId: BigInt(input.chainId),
        kk,
        node,
        bearer,
        maxDepth: 0,
        expires: input.expires,
        piece: labels,
        ...(pieceCid != null && { pieceCid }),
      })
      payload = encodeDelivery(claim.chain, await wrapTo(publicKeyOf(T), claim.nodeKey, descriptor))
      claim.nodeKey.fill(0)
    } finally {
      kk.fill(0)
    }
    payloadKind = 'delivery'
    expires = input.expires
  } else {
    const { grant: opened, sessionKey } = sender
    const held = opened.chain.links.at(-1)
    if (held != null && held.maxDepth >= 1) {
      const delegated = await delegateClaim(privateKeyToAccount(sessionKey), opened.chain, {
        parentKey: opened.key,
        node,
        bearer,
        maxDepth: 0,
        piece: labels,
        ...(pieceCid != null && { pieceCid }),
      })
      payload = encodeDelivery(delegated.chain, await wrapTo(publicKeyOf(T), delegated.nodeKey, descriptor))
      delegated.nodeKey.fill(0)
      payloadKind = 'delivery'
      expires = opened.chain.expires
    } else {
      // A Grant that cannot be re-shared: the piece key alone, which decrypts but cannot fetch once providers gate.
      const pieceKey = keyForEnvelope(opened.key, labels, opened.grant)
      payload = encodeGrant(await wrapTo(publicKeyOf(T), pieceKey, descriptor))
      pieceKey.fill(0)
      payloadKind = 'grant'
    }
  }

  const viewer = input.viewer ?? DEFAULT_VIEWER_URL
  if (input.mode === 'password' && salt != null) {
    return {
      link: formatShareLink(viewer, input.rootCid, payload, { kind: 'password', salt }),
      ...(input.password == null && password != null && { password }),
      payloadKind,
      ...(expires != null && { expires }),
    }
  }
  if (input.mode === 'restricted') {
    return {
      link: formatShareLink(viewer, input.rootCid, payload, { kind: 'access-key', key: T }),
      payloadKind,
      ...(expires != null && { expires }),
    }
  }
  return {
    link: formatShareLink(viewer, input.rootCid, payload),
    accessKey: accessKeyText(T),
    payloadKind,
    ...(expires != null && { expires }),
  }
}

/** T's private key for a parsed share: from the link, the Access key, or the password. */
export async function shareKey(
  share: ParsedShare,
  given: { accessKey?: string | undefined; password?: string | undefined }
): Promise<Hex> {
  if (share.secret?.kind === 'access-key') return share.secret.key
  if (share.secret?.kind === 'password') {
    if (given.password == null) throw new ShareLinkError('This Share link needs its password (--password)')
    return shareKeyFromPassword(given.password, share.secret.salt)
  }
  if (given.accessKey == null) throw new ShareLinkError('This Share link needs its Access key (--access-key fak1_…)')
  return parseAccessKey(given.accessKey)
}

/**
 * A FEE key resolver for a share: opens its payload with T and derives the upload's key, checking
 * the envelope's owner, group key and salt against the share. An expired delivery still decrypts:
 * expiry only ends fetching from gating providers.
 */
export function shareKeyResolver(share: ParsedShare, T: Hex): KeyResolver {
  return async ({ appMetadata }) => {
    let key: Uint8Array
    let grant: Grant
    try {
      // A delivery is a CBOR array (major type 4), a plain grant a map (major type 5).
      if ((share.payload[0] ?? 0) >> 5 === 4) {
        ;({ key, grant } = await openDelivery(T, share.payload))
      } else {
        grant = decodeGrant(share.payload)
        key = await unwrapWith(T, grant)
      }
    } catch {
      throw new ShareLinkError('The Access key or password does not open this share')
    }
    try {
      return keyForEnvelope(key, appMetadata, grant)
    } catch (error) {
      throw new ShareLinkError(
        `This share is for another upload: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      key.fill(0)
    }
  }
}
