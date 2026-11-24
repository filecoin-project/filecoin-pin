/**
 * Share links (#779): one encrypted upload, shared with someone who has no key pair.
 *
 * A share is a Keysmith piece grant: the upload's key wrapped to a throwaway key T that the sender
 * makes for the recipient. Nothing flows back from the recipient, so it works for anyone on the web.
 *
 * T's private key travels inside the link (the default), or as an Access key the recipient is
 * sent separately and pastes in (`--restricted`):
 *
 *   <viewer>#v1/<encrypted root CID>&d=<payload>[&s=<providers>][&k=fak1_<key>]
 *
 * Every value is base64url without padding, except `s`. Everything is in the fragment, so nothing
 * reaches a server. Every link has its own T, so links are independent.
 *
 * ## Private uploads (#821)
 *
 * A public upload's link carries a plain piece grant (a CBOR map): the key alone, since anyone may
 * fetch the ciphertext. A private upload is served only on the authenticated path, so its link
 * also carries the right to fetch it, as a Keysmith Delivery (a CBOR array) in `d`:
 *
 * - the claim chain ends in a `piece:<salt>` claim whose bearer is T's address, with the CID to
 *   fetch as its locator: the upload's IPFS root, or its piece CID (not signed, and not needed to
 *   verify: it says what to ask for);
 * - the grant wraps that piece's key to T, as for a public upload.
 *
 * The owner wallet signs that claim as a root of its own. A session key delegates it from the
 * Grant that covers the piece, which must allow onward delegation (`maxDepth` >= 1). The link
 * stops opening when the chain expires: the Grant's expiry for a session key, and
 * {@link PRIVATE_SHARE_LIFETIME_SECONDS} for the owner.
 *
 * `s` lists the providers that hold the piece, as comma-separated, URI-encoded service URLs: a
 * reader with no chain access (the viewer) has no other way to find them. A reader signs a fresh
 * read request with T for each fetch (`authorizationHeader`) and presents it at
 * `<provider>/download/<locator>`. A link with a Delivery is new: a reader that predates it
 * refuses `s`, and fails rather than misreading the link.
 */

import {
  authorizationHeader,
  type ClaimChain,
  decodeDelivery,
  decodeGrant,
  delegateClaim,
  deriveGroupKey,
  encodeDelivery,
  encodeGrant,
  type Grant,
  grantDescriptor,
  keyForEnvelope,
  type PieceMetadata,
  pieceNode,
  publicKeyOf,
  readPieceMetadata,
  rootClaim,
  unwrapWith,
  wrapTo,
} from '@filoz/keysmith'
import type { KeyResolver } from 'filecoin-encryption-envelope'
import { CID } from 'multiformats/cid'
import { type Address, bytesToHex, getAddress, type Hex, hexToBytes } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { format1Message, KeyAccessError, type OwnerSigner } from './group-key.js'
import { GRANT_PREFIX, grantForPiece, type OpenedGrant } from './group-key-grant.js'
import type { Authorizations } from './ipfs-car-fetch.js'

/** The v1 Share link viewer the links open in (FilOzone/synapse-sdk#1036). */
export const DEFAULT_VIEWER_URL = 'https://viewer.filecoin.cloud/'

/** Prefix of an Access key's text form: lets both sides refuse a wrong paste, and secret scanners find a leak. */
export const ACCESS_KEY_PREFIX = 'fak1_'

/** `open`: the link alone opens the upload. `restricted`: the link also needs its Access key. */
export type ShareMode = 'open' | 'restricted'

export interface ParsedShare {
  rootCid: CID
  /** A Keysmith piece grant, CBOR; or, for a private upload, a Delivery. */
  payload: Uint8Array
  /** For a private upload: the providers that hold it (`s`). */
  providers?: string[]
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

/** `<viewer>#v1/<rootCid>&d=<payload>`, then `&s=` for a private upload's providers, then `&k=` for an open link. */
export function formatShareLink(
  viewer: string,
  rootCid: CID,
  payload: Uint8Array,
  accessKey?: Hex,
  providers?: readonly string[]
): string {
  const base = viewer.split('#')[0] ?? viewer
  let fragment = `v1/${rootCid.toString()}&d=${b64(payload)}`
  if (providers != null && providers.length > 0) fragment += `&s=${providers.map(encodeURIComponent).join(',')}`
  if (accessKey != null) fragment += `&k=${accessKeyText(accessKey)}`
  return `${base}#${fragment}`
}

/** A provider's service URL from a link's `s`: http(s) only, no credentials, no trailing slash. */
function providerUrl(text: string): string {
  let url: URL
  try {
    url = new URL(decodeURIComponent(text))
  } catch {
    throw new ShareLinkError('The Share link names a provider that is not a URL; copy it again')
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') {
    throw new ShareLinkError('The Share link names a provider that is not an http(s) URL; copy it again')
  }
  return url.toString().replace(/\/+$/, '')
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
    if (!['d', 's', 'k'].includes(name) || values.has(name)) {
      throw new ShareLinkError(`The Share link has an unexpected part "${name}"; copy it again`)
    }
    values.set(name, param.slice(at + 1))
  }
  const d = values.get('d')
  if (d == null || d === '') throw new ShareLinkError('The Share link is incomplete (no share in it); copy it again')
  const k = values.get('k')
  const s = values.get('s')
  return {
    rootCid,
    payload: unb64(d, 'The share'),
    ...(s != null && s !== '' && { providers: s.split(',').map(providerUrl) }),
    ...(k != null && { accessKey: parseAccessKey(k) }),
  }
}

/**
 * Who shares: the owner wallet, or a session key's opened group key Grants. A private upload's
 * link is delegated from a Grant, so it also needs the session key that bears them.
 */
export type ShareSender = { owner: OwnerSigner } | { grants: OpenedGrant[]; sessionKey?: Hex }

/** How long a private upload's link made by the owner wallet opens. */
// ponytail: fixed lifetime; add a --expires flag when someone needs another one
export const PRIVATE_SHARE_LIFETIME_SECONDS = 30 * 24 * 3600

/** Where a private upload is fetched: `/download/<cid>` on these providers. */
export interface PrivateShareTarget {
  /** The upload's IPFS root, or its piece CID. */
  cid: string
  /** Service URLs of the providers that hold it. */
  providers: readonly string[]
  /** The network the claim is for. */
  chainId: number
}

export interface CreateShareInput {
  sender: ShareSender
  rootCid: CID
  /** The upload's envelope labels (`appMetadata`): they name its group key, owner and salt. */
  labels: PieceMetadata
  mode: ShareMode
  viewer?: string
  /** A private upload: the link also carries the right to fetch it (a Delivery), and where. */
  private?: PrivateShareTarget
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
  try {
    return await shareWith(input)
  } finally {
    // Whatever fails, from reading the labels on: the Grants' keys never outlive this call.
    if ('grants' in input.sender) for (const g of input.sender.grants) g.key.fill(0)
  }
}

async function shareWith(input: CreateShareInput): Promise<CreatedShare> {
  const { labels, sender } = input
  const view = readPieceMetadata(labels)
  const owner = view.owner ?? ('owner' in sender ? sender.owner.address : sender.grants[0]?.owner)
  if (owner == null) throw new ShareLinkError('This session key has no group key Grant')
  const ref = { owner, groupKeyId: view.groupKeyId }
  const node = pieceNode(labels)
  const T = generatePrivateKey()

  if ('owner' in sender && owner.toLowerCase() !== sender.owner.address.toLowerCase()) {
    throw new ShareLinkError(`This upload belongs to ${owner}, not ${sender.owner.address.toLowerCase()}`)
  }
  // The key the link opens, and for a private upload the claim chain that lets T fetch it.
  let pieceKey: Uint8Array
  let chain: ClaimChain | undefined
  try {
    if (input.private != null) ({ pieceKey, chain } = await privateClaim(sender, ref, labels, T, input.private))
    else if ('owner' in sender) {
      const { groupKey } = await deriveGroupKey(sender.owner, ref)
      try {
        pieceKey = keyForEnvelope(groupKey, labels)
      } finally {
        groupKey.fill(0)
      }
    } else {
      const picked = grantForPiece(sender.grants, labels)
      pieceKey = keyForEnvelope(picked.key, labels, picked.grant)
    }
  } finally {
    if ('grants' in sender) for (const g of sender.grants) g.key.fill(0)
  }
  let payload: Uint8Array
  try {
    const grant = await wrapTo(publicKeyOf(T), pieceKey, grantDescriptor(ref, node))
    payload = chain == null ? encodeGrant(grant) : encodeDelivery(chain, grant)
  } finally {
    pieceKey.fill(0)
  }

  const viewer = input.viewer ?? DEFAULT_VIEWER_URL
  const providers = input.private?.providers
  if (input.mode === 'open') return { link: formatShareLink(viewer, input.rootCid, payload, T, providers) }
  return { link: formatShareLink(viewer, input.rootCid, payload, undefined, providers), accessKey: accessKeyText(T) }
}

/**
 * A `piece:` claim for one private upload with T's address as bearer, and the piece key it carries.
 * The owner signs it as a root; a session key delegates it from the Grant that covers the piece.
 */
async function privateClaim(
  sender: ShareSender,
  ref: { owner: Address; groupKeyId: Hex },
  labels: PieceMetadata,
  T: Hex,
  target: PrivateShareTarget
): Promise<{ pieceKey: Uint8Array; chain: ClaimChain }> {
  const node = pieceNode(labels)
  const bearer = privateKeyToAccount(T).address
  // Keysmith calls the locator pieceCid; it is opaque, and any CID the provider resolves will do.
  const pieceCid = CID.parse(target.cid).bytes
  if ('owner' in sender) {
    const { groupKey } = await deriveGroupKey(sender.owner, ref)
    try {
      const { chain, nodeKey } = await rootClaim(sender.owner, {
        ...ref,
        chainId: BigInt(target.chainId),
        groupKey,
        node,
        bearer,
        maxDepth: 0,
        expires: Math.floor(Date.now() / 1000) + PRIVATE_SHARE_LIFETIME_SECONDS,
        piece: labels,
        pieceCid,
      })
      return { pieceKey: nodeKey, chain }
    } finally {
      groupKey.fill(0)
    }
  }
  if (sender.sessionKey == null)
    throw new ShareLinkError('A private upload is shared from the session key that bears its Grant')
  const picked = grantForPiece(sender.grants, labels)
  if ((picked.chain.links.at(-1)?.maxDepth ?? 0) < 1) {
    throw new ShareLinkError(
      `This session key's Grant for ${picked.group == null ? 'the group key' : `group ${picked.group}`} allows no delegation, so it cannot share a private upload: run \`filecoin-pin login --group ${picked.group ?? '<group>'}\` without --delegation-depth 0 for one that does`
    )
  }
  const { chain, nodeKey } = await delegateClaim(privateKeyToAccount(sender.sessionKey), picked.chain, {
    parentKey: picked.key,
    node,
    bearer,
    maxDepth: 0,
    piece: labels,
    pieceCid,
  })
  return { pieceKey: nodeKey, chain }
}

/** T's private key for a parsed share: from the link, else the Access key sent with it. */
export function shareKey(share: ParsedShare, accessKey: string | undefined): Hex {
  if (share.accessKey != null) return share.accessKey
  if (accessKey == null) throw new ShareLinkError('This Share link needs its Access key (--access-key fak1_…)')
  return parseAccessKey(accessKey)
}

/** Whether a share's payload is a Delivery (a CBOR array: a private upload), rather than a plain grant (a map). */
const isDelivery = (share: ParsedShare): boolean => share.payload[0] != null && share.payload[0] >> 5 === 4

/**
 * Open a share's payload with T: the shared key and the grant that names its owner, group key and
 * node; for a private upload also the claim chain that lets T fetch it.
 */
async function openPayload(share: ParsedShare, T: Hex): Promise<{ key: Uint8Array; grant: Grant; chain?: ClaimChain }> {
  if (!isDelivery(share)) {
    try {
      const grant = decodeGrant(share.payload)
      return { key: await unwrapWith(T, grant), grant }
    } catch (error) {
      // A link from filecoin-pin 2.3 or 2.4 (keysmith 0.1.0) is whole, in a format this version no longer reads.
      throw new ShareLinkError(format1Message(error) ?? 'The Access key does not open this share')
    }
  }
  // Not keysmith's openDelivery: verifying a chain that narrows a group to a piece needs the piece's
  // labels, which a recipient reads only from the piece it is about to fetch. The recipient doesn't need
  // the verification: the chain is presented, and the gate verifies it against the piece's real labels;
  // the key is checked by keyForEnvelope (owner, group key, salt) and by FEE's authentication.
  let chain: ClaimChain
  let grant: Grant
  try {
    ;({ chain, grant } = decodeDelivery(share.payload))
  } catch (error) {
    throw new ShareLinkError(
      format1Message(error) ?? 'The Share link is damaged (its share does not decode); copy it again'
    )
  }
  const bearer = chain.links.at(-1)?.bearer
  if (bearer == null || getAddress(bearer) !== privateKeyToAccount(T).address) {
    throw new ShareLinkError('The Access key does not open this share')
  }
  // The link's expiry is the chain's, which its sender set.
  if (chain.expires <= Math.floor(Date.now() / 1000)) {
    throw new ShareLinkError(`This share expired at ${new Date(chain.expires * 1000).toISOString()}`)
  }
  try {
    return { key: await unwrapWith(T, grant), grant, chain }
  } catch {
    throw new ShareLinkError('The Access key does not open this share')
  }
}

/**
 * For a private upload's share: the CID to fetch (the link's locator), and fresh `Authorization`
 * headers for it, signed with T. Undefined for a public upload's share, which is fetched on the open path.
 */
export async function shareDownload(
  share: ParsedShare,
  T: Hex
): Promise<{ cid: string; authorizations: Authorizations } | undefined> {
  const { key, chain } = await openPayload(share, T)
  key.fill(0)
  if (chain == null) return undefined
  const locator = chain.links.at(-1)?.pieceCid
  if (locator == null) throw new ShareLinkError('This private share names nothing to fetch; ask for a new link')
  const bearer = privateKeyToAccount(T)
  return {
    cid: CID.decode(locator).toString(),
    // Signed over the CID in the URL, as the provider checks.
    authorizations: async (cid) => [await authorizationHeader(bearer, chain, { pieceCid: CID.parse(cid).bytes })],
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
