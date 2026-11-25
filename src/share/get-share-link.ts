/**
 * Mint a Share link (#779) for one encrypted upload, named by its Encrypted root CID.
 *
 * The upload's header labels (owner, group key, salt) come from its own verified first blocks
 * (`envelope-labels.ts`).
 * The sharer's credentials then derive the upload's key: nothing else is downloaded or decrypted.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PieceMetadata } from '@filoz/keysmith'
import { CID } from 'multiformats/cid'
import pc from 'picocolors'
import type { Logger } from 'pino'
import type { Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CliFatal } from '../common/cli-errors.js'
import { envelopeLabelsFromCar, readEnvelopeLabels } from '../common/envelope-labels.js'
import { GRANT_LOGIN_COMMAND, ownerAuthorizations } from '../common/group-key.js'
import { grantAuthorizations, loadGroupKeyGrants } from '../common/group-key-grant.js'
import {
  type Authorizations,
  DISCOVERY_TIMEOUT_MS,
  FetchFailedError,
  fetchVerifiedCar,
  ipniProviderUrls,
  NoProviderError,
} from '../common/ipfs-car-fetch.js'
import { type CreatedShare, createShare, type ShareMode, type ShareSender } from '../common/share-link.js'
import type { SynapseSetupConfig } from '../core/synapse/index.js'
import { addressOf, ownProviders, readOnlySynapse } from '../get/get.js'
import { type CLIAuthOptions, getCLILogger, parseCLIAuth } from '../utils/cli-auth.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'

const SHARE_NEEDS_CREDENTIALS = `Sharing needs the owner wallet (set PRIVATE_KEY) or a session key with a group key Grant (run \`${GRANT_LOGIN_COMMAND}\`).`

export interface GetShareLinkOptions extends CLIAuthOptions {
  restricted?: boolean
  viewer?: string
  /** A private upload's piece CID: its header is read on the authenticated path, and the link fetches it there. */
  piece?: string
}

/**
 * A private upload's header labels, from its piece fetched on the authenticated path with the owner
 * wallet or the session key's Grants, and the providers that hold it (the sharer's own read-restricted
 * data sets), fetched at `/download/<piece>`, or `/download/<root>` without `piece`. Undefined
 * without `piece` when none of them serves the root, so the upload may be public.
 */
async function findPrivateUpload(
  cid: CID,
  piece: string | undefined,
  auth: SynapseSetupConfig,
  address: Address,
  chainId: number,
  logger: Logger
): Promise<{ labels: PieceMetadata; providers: string[]; target: string } | undefined> {
  // The owner wallet authorizes itself; a session key presents its Grants.
  let authorizations: Authorizations
  const synapse = await readOnlySynapse(auth, address, logger)
  if ('privateKey' in auth && auth.privateKey != null) {
    authorizations = ownerAuthorizations(synapse, privateKeyToAccount(auth.privateKey), logger)
  } else if ('sessionKey' in auth && auth.sessionKey != null) {
    const session = { sessionKey: auth.sessionKey, walletAddress: auth.walletAddress }
    authorizations = grantAuthorizations(session, chainId)
  } else {
    throw new Error(
      '--piece needs the owner wallet (PRIVATE_KEY) or a session key holding a group key Grant (`filecoin-pin login --group <group>`)'
    )
  }
  // What the link will ask for, and what is read here: the piece if named, else the root.
  const target = piece ?? cid.toString()
  const providers = [...new Set(await ownProviders(auth, address, logger, true))]
  const dir = await mkdtemp(join(tmpdir(), 'filecoin-pin-share-'))
  try {
    const carPath = join(dir, 'piece.car')
    // ponytail: downloads the whole upload to read its header. The outer CAR is written leaves first
    // with the root last, so the first leaf (the header) can only be verified against the root once
    // the end is in. A metadata-first outer CAR, like the inner one, would make this a short read.
    let served: string
    try {
      ;({ provider: served } = await fetchVerifiedCar(
        cid,
        [{ name: 'Data set', find: async () => providers }],
        carPath,
        {
          logger,
          download: { cid: target, authorizations },
        }
      ))
    } catch (error) {
      // Not among the private uploads: it may still be public. --piece names a private upload only.
      if (piece != null || !(error instanceof NoProviderError || error instanceof FetchFailedError)) throw error
      logger.debug({ reason: error.message }, 'Not served from a private data set')
      return undefined
    }
    // The link names only the provider that served it, not every provider the sharer uses.
    return { labels: await envelopeLabelsFromCar(carPath, cid), providers: [served], target }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The envelope header's labels, read from providers found through IPNI and the sharer's IPFS-indexed data sets. */
async function findEnvelopeLabels(
  cid: CID,
  auth: SynapseSetupConfig,
  address: Address,
  logger: Logger
): Promise<PieceMetadata> {
  // A failed lookup only narrows the list; readEnvelopeLabels says if nothing is left.
  const [ipni, own] = await Promise.all([
    ipniProviderUrls(cid, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) }).catch((error: unknown) => {
      logger.warn({ error }, 'IPNI lookup failed')
      return []
    }),
    ownProviders(auth, address, logger).catch((error: unknown) => {
      logger.warn({ error }, 'Data set provider lookup failed')
      return []
    }),
  ])
  return readEnvelopeLabels(cid, [...new Set([...ipni, ...own])])
}

/** The owner wallet, else the session key with its group key Grant. */
export async function shareSender(auth: SynapseSetupConfig, chainId: number): Promise<ShareSender> {
  if ('privateKey' in auth && auth.privateKey != null) return { owner: privateKeyToAccount(auth.privateKey) }
  if ('sessionKey' in auth && auth.sessionKey != null) {
    const session = { sessionKey: auth.sessionKey, walletAddress: auth.walletAddress }
    return { grants: await loadGroupKeyGrants(session, chainId), sessionKey: auth.sessionKey }
  }
  throw new Error(SHARE_NEEDS_CREDENTIALS)
}

/** The closing reminder: how the link and its secret should travel. */
export const shareReminder = (mode: ShareMode): string =>
  mode === 'open'
    ? 'Anyone with the link can read this upload: send it only where that is acceptable'
    : 'Send the link and the Access key by different channels'

/** A `--no-ipfs` upload: nothing finds its blocks by CID, so neither the viewer nor `get --share` could open a link to it. */
export const NO_IPFS_SHARE =
  'Content added with --no-ipfs cannot be shared: a Share link fetches it by its IPFS root CID'

/** A `--private` upload: its pieces are not served on the open path a Share link reads (private share links: #821). */
/** The link and its secret as plain lines, after the summary, so they copy cleanly. */
export function printShare(share: CreatedShare): void {
  console.log(`Share link:\n${share.link}`)
  if (share.accessKey != null) console.log(`\nAccess key:\n${share.accessKey}`)
}

export async function runGetShareLink(cidArg: string, options: GetShareLinkOptions): Promise<void> {
  intro(pc.bold('Filecoin Pin Share Link'))
  const spinner = createSpinner()
  try {
    let cid: CID
    try {
      cid = CID.parse(cidArg)
    } catch {
      throw new Error(`Not an IPFS root CID: ${cidArg}`)
    }
    const mode: ShareMode = options.restricted === true ? 'restricted' : 'open'
    const auth = parseCLIAuth(options)
    const address = addressOf(auth)
    // Owner and session credentials both name an address; shareSender refuses a view-only one.
    if (address == null) throw new Error(SHARE_NEEDS_CREDENTIALS)
    const logger = getCLILogger()

    spinner.start('Reading the envelope header...')
    // `--rpc-url` leaves the network to be probed.
    const chainId = auth.chain?.id ?? (await readOnlySynapse(auth, address, logger)).chain.id
    const { piece } = options
    const found = (await findPrivateUpload(cid, piece, auth, address, chainId, logger)) ?? {
      labels: await findEnvelopeLabels(cid, auth, address, logger),
      providers: undefined,
      target: undefined,
    }
    spinner.message('Creating the share...')
    const share = await createShare({
      // Opened only now: createShare zeroes the Grants' keys however it ends, and nothing in between can throw.
      sender: await shareSender(auth, chainId),
      rootCid: cid,
      labels: found.labels,
      mode,
      ...(options.viewer != null && { viewer: options.viewer }),
      ...(found.target != null &&
        found.providers != null && { private: { cid: found.target, providers: found.providers, chainId } }),
    })
    spinner.stop(`${pc.green('✓')} Share link created`)

    outro(shareReminder(mode))
    printShare(share)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    spinner.stop(`${pc.red('✗')} ${message}`)
    cancel('Share link not created')
    throw new CliFatal(message)
  }
}
