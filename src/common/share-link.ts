/**
 * Share links (#779): one encrypted upload, shared with someone who has no key pair.
 *
 * A share is a Keysmith piece grant: the upload's key wrapped to a throwaway key T that the sender
 * makes for the recipient. Nothing flows back from the recipient, so it works for anyone on the web.
 *
 * T's private key travels inside the link (the default), or as an Access key the recipient is
 * sent separately and pastes in (`--restricted`):
 *
 *   <viewer>#v1/<encrypted root CID>&d=<payload>[&k=fak1_<key>]
 *
 * Every value is base64url without padding. Everything is in the fragment, so nothing reaches a
 * server. Every link has its own T, so links are independent.
 */

import {
  decodeGrant,
  keyspaceKeys as deriveGroupKey,
  encodeGrant,
  type Grant,
  grantDescriptor,
  keyForEnvelope,
  type PieceMetadata,
  pieceNode,
  publicKeyOf,
  unwrapWith,
  wrapTo,
} from '@filoz/keysmith'
import type { KeyResolver } from 'filecoin-encryption-envelope'
import { CID } from 'multiformats/cid'
import { type Address, bytesToHex, getAddress, type Hex, hexToBytes } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { KeyAccessError, type OwnerSigner } from './group-key.js'
import { GRANT_PREFIX, type OpenedGrant } from './group-key-grant.js'

/** The v1 Share link viewer the links open in (FilOzone/synapse-sdk#1036). */
export const DEFAULT_VIEWER_URL =
  'https://bafkreibthn4gniz2rjyi6rpcqn6lavpbdgok3w5dj2zghou4hem4bfuiqa.ipfs.inbrowser.link/'

/** Prefix of an Access key's text form: lets both sides refuse a wrong paste, and secret scanners find a leak. */
export const ACCESS_KEY_PREFIX = 'fak1_'

/** `open`: the link alone opens the upload. `restricted`: the link also needs its Access key. */
export type ShareMode = 'open' | 'restricted'

export interface ParsedShare {
  rootCid: CID
  /** A Keysmith piece grant, CBOR. */
  payload: Uint8Array
  /** The Access key, when the link carries it (an open link). Absent from a restricted link. */
  accessKey?: Hex
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

/** `<viewer>#v1/<rootCid>&d=<payload>`, then `&k=` for an open link. */
export function formatShareLink(viewer: string, rootCid: CID, payload: Uint8Array, accessKey?: Hex): string {
  const base = viewer.split('#')[0] ?? viewer
  let fragment = `v1/${rootCid.toString()}&d=${b64(payload)}`
  if (accessKey != null) fragment += `&k=${accessKeyText(accessKey)}`
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
    if (!['d', 'k'].includes(name) || values.has(name)) {
      throw new ShareLinkError(`The Share link has an unexpected part "${name}"; copy it again`)
    }
    values.set(name, param.slice(at + 1))
  }
  const d = values.get('d')
  if (d == null || d === '') throw new ShareLinkError('The Share link is incomplete (no share in it); copy it again')
  const k = values.get('k')
  return { rootCid, payload: unb64(d, 'The share'), ...(k != null && { accessKey: parseAccessKey(k) }) }
}

/** Who shares: the owner wallet, or a session key's opened group key Grant. */
export type ShareSender = { owner: OwnerSigner } | { grant: OpenedGrant }

export interface CreateShareInput {
  sender: ShareSender
  rootCid: CID
  /** The upload's envelope labels (`appMetadata`): they name its group key, owner and salt. */
  labels: PieceMetadata
  mode: ShareMode
  viewer?: string
}

export interface CreatedShare {
  link: string
  /** The Access key to send separately (restricted mode only). */
  accessKey?: string
}

/**
 * Mint a share link for one upload, wrapped to a fresh key T.
 *
 * @throws If the sender holds no key for the upload.
 */
export async function createShare(input: CreateShareInput): Promise<CreatedShare> {
  const { labels, sender } = input
  const ref = { owner: labels['foc/own'], keyspace: labels['foc/ks'] }
  const node = pieceNode(labels)
  const T = generatePrivateKey()

  let pieceKey: Uint8Array
  if ('owner' in sender) {
    if (labels['foc/own'].toLowerCase() !== sender.owner.address.toLowerCase()) {
      throw new ShareLinkError(`This upload belongs to ${labels['foc/own']}, not ${sender.owner.address.toLowerCase()}`)
    }
    const { kk } = await deriveGroupKey(sender.owner, ref)
    try {
      pieceKey = keyForEnvelope(kk, labels)
    } finally {
      kk.fill(0)
    }
  } else {
    pieceKey = keyForEnvelope(sender.grant.key, labels, sender.grant.grant)
  }
  let payload: Uint8Array
  try {
    payload = encodeGrant(await wrapTo(publicKeyOf(T), pieceKey, grantDescriptor(ref, node)))
  } finally {
    pieceKey.fill(0)
  }

  const viewer = input.viewer ?? DEFAULT_VIEWER_URL
  if (input.mode === 'open') return { link: formatShareLink(viewer, input.rootCid, payload, T) }
  return { link: formatShareLink(viewer, input.rootCid, payload), accessKey: accessKeyText(T) }
}

/** T's private key for a parsed share: from the link, else the Access key sent with it. */
export function shareKey(share: ParsedShare, accessKey: string | undefined): Hex {
  if (share.accessKey != null) return share.accessKey
  if (accessKey == null) throw new ShareLinkError('This Share link needs its Access key (--access-key fak1_…)')
  return parseAccessKey(accessKey)
}

/** Open a share's payload with T: the shared key and the grant that names its owner, group key and node. */
async function openPayload(share: ParsedShare, T: Hex): Promise<{ key: Uint8Array; grant: Grant }> {
  try {
    const grant = decodeGrant(share.payload)
    return { key: await unwrapWith(T, grant), grant }
  } catch {
    throw new ShareLinkError('The Access key does not open this share')
  }
}

/**
 * The wallet the shared upload belongs to, as the share's grant names it, so a reader can search
 * that wallet's own data sets for providers. Opening the payload also checks T before any download.
 */
export async function shareOwner(share: ParsedShare, T: Hex): Promise<Address> {
  const { key, grant } = await openPayload(share, T)
  key.fill(0)
  return getAddress(grant.owner)
}

/**
 * A FEE key resolver for a share: opens its payload with T and derives the upload's key, checking
 * the envelope's owner, group key and salt against the share.
 */
export function shareKeyResolver(share: ParsedShare, T: Hex): KeyResolver {
  return async ({ appMetadata }) => {
    const { key, grant } = await openPayload(share, T)
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
