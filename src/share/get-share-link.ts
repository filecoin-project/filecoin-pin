/**
 * Mint a Share link (#779) for one encrypted upload, named by its Encrypted root CID.
 *
 * The upload's header labels (owner, group key, salt) come from this machine's upload record
 * (`upload-record.ts`), else from the upload's own verified first blocks (`envelope-labels.ts`).
 * The sharer's credentials then derive the upload's key: nothing else is downloaded or decrypted.
 */

import type { PieceMetadata } from '@filoz/keysmith'
import { CID } from 'multiformats/cid'
import pc from 'picocolors'
import type { Logger } from 'pino'
import type { Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CliFatal } from '../common/cli-errors.js'
import { readEnvelopeLabels } from '../common/envelope-labels.js'
import { GRANT_LOGIN_COMMAND } from '../common/group-key.js'
import { loadGroupKeyGrant } from '../common/group-key-grant.js'
import { DISCOVERY_TIMEOUT_MS, ipniProviderUrls } from '../common/ipfs-car-fetch.js'
import { type CreatedShare, createShare, type ShareMode, type ShareSender } from '../common/share-link.js'
import { findEncryptedUpload } from '../common/upload-record.js'
import type { SynapseSetupConfig } from '../core/synapse/index.js'
import { addressOf, ownProviders, readOnlySynapse } from '../get/get.js'
import { type CLIAuthOptions, getCLILogger, parseCLIAuth } from '../utils/cli-auth.js'
import { cancel, createSpinner, intro, outro, parsePositiveInt } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'

/** Owner-mode links stop fetching from gating providers after this many days, unless `--expires` says otherwise. */
export const DEFAULT_SHARE_DAYS = 30

const SHARE_NEEDS_CREDENTIALS = `Sharing needs the owner wallet (set PRIVATE_KEY) or a session key with a group key Grant (run \`${GRANT_LOGIN_COMMAND}\`).`

export interface GetShareLinkOptions extends CLIAuthOptions {
  /** `true` for a generated password, or the password itself. */
  password?: string | boolean
  restricted?: boolean
  /** Days, owner mode only. */
  expires?: string
  viewer?: string
}

/** The upload's labels and, when this machine recorded it, its piece CID. */
async function uploadLabels(
  cid: CID,
  auth: SynapseSetupConfig,
  address: Address,
  logger: Logger
): Promise<{ labels: PieceMetadata; pieceCid?: CID }> {
  const record = findEncryptedUpload(cid.toString())
  if (record != null) return { labels: record.labels, pieceCid: CID.parse(record.pieceCid) }
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
  // ponytail: no piece CID without a record. The link still decrypts; a gating provider's request
  // needs the locator, so add a lookup through the owner's data set pieces once gating ships.
  return { labels: await readEnvelopeLabels(cid, [...new Set([...ipni, ...own])]) }
}

/** The owner wallet, else the session key with its group key Grant. */
export async function shareSender(auth: SynapseSetupConfig, chainId: number): Promise<ShareSender> {
  if ('privateKey' in auth && auth.privateKey != null) return { owner: privateKeyToAccount(auth.privateKey) }
  if ('sessionKey' in auth && auth.sessionKey != null) {
    const session = { sessionKey: auth.sessionKey, walletAddress: auth.walletAddress }
    return { sessionKey: auth.sessionKey, grant: await loadGroupKeyGrant(session, chainId) }
  }
  throw new Error(SHARE_NEEDS_CREDENTIALS)
}

/** Unix seconds `days` from now: when an owner-mode link stops fetching from gating providers. */
export const expiresIn = (days: number): number => Math.floor(Date.now() / 1000) + days * 86400

/** What the link can and cannot do, as notes above the summary. */
export function logShareNotes(share: CreatedShare): void {
  if (share.payloadKind === 'grant') {
    log.warn(
      "This session's Grant cannot be re-shared, so the link carries the upload's key only: it decrypts, but cannot fetch from providers that gate retrieval."
    )
  } else if (share.expires != null) {
    log.info(
      `Fetching from providers that gate retrieval ends ${new Date(share.expires * 1000).toISOString()}; decrypting never does.`
    )
  }
}

/** The link and its secret as plain lines, after the summary, so they copy cleanly. */
export function printShare(share: CreatedShare): void {
  console.log(`Share link:\n${share.link}`)
  if (share.accessKey != null) console.log(`\nAccess key:\n${share.accessKey}`)
  if (share.password != null) console.log(`\nPassword:\n${share.password}`)
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
    if (options.password != null && options.restricted === true) {
      throw new Error('Choose --password or --restricted, not both')
    }
    const mode: ShareMode =
      options.password != null ? 'password' : options.restricted === true ? 'restricted' : 'access-key'
    const days = options.expires == null ? DEFAULT_SHARE_DAYS : parsePositiveInt(options.expires, '--expires')
    const auth = parseCLIAuth(options)
    const address = addressOf(auth)
    // Owner and session credentials both name an address; shareSender refuses a view-only one.
    if (address == null) throw new Error(SHARE_NEEDS_CREDENTIALS)
    const logger = getCLILogger()

    spinner.start('Reading the upload header...')
    // `--rpc-url` leaves the network to be probed.
    const chainId = auth.chain?.id ?? (await readOnlySynapse(auth, address, logger)).chain.id
    const sender = await shareSender(auth, chainId)
    const upload = await uploadLabels(cid, auth, address, logger)
    spinner.message('Creating the share...')
    const share = await createShare({
      sender,
      rootCid: cid,
      labels: upload.labels,
      ...(upload.pieceCid != null && { pieceCid: upload.pieceCid }),
      chainId,
      mode,
      ...(typeof options.password === 'string' && { password: options.password }),
      expires: expiresIn(days),
      ...(options.viewer != null && { viewer: options.viewer }),
    })
    spinner.stop(`${pc.green('✓')} Share link created`)

    if ('grant' in sender && options.expires != null) {
      log.warn("--expires was ignored: a session key's links last as long as its Grant")
    }
    logShareNotes(share)
    outro(
      mode === 'restricted' ? 'Anyone with the link can read this upload' : 'Send the link and its secret separately'
    )
    printShare(share)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    spinner.stop(`${pc.red('✗')} ${message}`)
    cancel('Share link not created')
    throw new CliFatal(message)
  }
}
