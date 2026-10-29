/**
 * Mint a Share link (#779) for one encrypted upload, named by its Encrypted root CID.
 *
 * The upload's header labels (owner, group key, salt) come from its own verified first blocks
 * (`envelope-labels.ts`).
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
import type { SynapseSetupConfig } from '../core/synapse/index.js'
import { addressOf, ownProviders, readOnlySynapse } from '../get/get.js'
import { type CLIAuthOptions, getCLILogger, parseCLIAuth } from '../utils/cli-auth.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'

const SHARE_NEEDS_CREDENTIALS = `Sharing needs the owner wallet (set PRIVATE_KEY) or a session key with a group key Grant (run \`${GRANT_LOGIN_COMMAND}\`).`

export interface GetShareLinkOptions extends CLIAuthOptions {
  restricted?: boolean
  viewer?: string
}

/** The upload's labels, from providers found through IPNI and the sharer's IPFS-indexed data sets. */
async function uploadLabels(
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
    return { grant: await loadGroupKeyGrant(session, chainId) }
  }
  throw new Error(SHARE_NEEDS_CREDENTIALS)
}

/** The closing reminder: how the link and its secret should travel. */
export const shareReminder = (mode: ShareMode): string =>
  mode === 'restricted'
    ? 'Anyone with the link can read this upload: send it only where that is acceptable'
    : 'Send the link and the Access key by different channels'

/** A `--no-ipfs` upload: nothing finds its blocks by CID, so neither the viewer nor `get --share` could open a link to it. */
export const NO_IPFS_SHARE = 'A --no-ipfs upload cannot be shared: a Share link fetches the upload by its IPFS root CID'

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
    const mode: ShareMode = options.restricted === true ? 'restricted' : 'access-key'
    const auth = parseCLIAuth(options)
    const address = addressOf(auth)
    // Owner and session credentials both name an address; shareSender refuses a view-only one.
    if (address == null) throw new Error(SHARE_NEEDS_CREDENTIALS)
    const logger = getCLILogger()

    spinner.start('Reading the upload header...')
    // `--rpc-url` leaves the network to be probed.
    const chainId = auth.chain?.id ?? (await readOnlySynapse(auth, address, logger)).chain.id
    const sender = await shareSender(auth, chainId)
    const labels = await uploadLabels(cid, auth, address, logger)
    spinner.message('Creating the share...')
    const share = await createShare({
      sender,
      rootCid: cid,
      labels,
      mode,
      ...(options.viewer != null && { viewer: options.viewer }),
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
