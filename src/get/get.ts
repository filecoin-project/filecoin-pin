/**
 * Fetch an upload by its IPFS root CID into a directory, decrypting it when it was
 * uploaded with `add --encrypt`.
 */

import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CID } from 'multiformats/cid'
import pc from 'picocolors'
import type { Logger } from 'pino'
import { type Address, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CliFatal, EXIT_CODE_INCOMPLETE, isCliIncomplete } from '../common/cli-errors.js'
import { checkOutputDir, removeDecryptOutput } from '../common/encryption.js'
import { ownerAuthorizations } from '../common/group-key.js'
import { credentialKeyResolver, grantAuthorizations } from '../common/group-key-grant.js'
import {
  type Authorizations,
  FetchFailedError,
  ipniProviderUrls,
  NoProviderError,
  ownProviderUrls,
  type ProviderSource,
} from '../common/ipfs-car-fetch.js'
import { type GetOptions, type GetResult, getToDirectory } from '../common/ipfs-get.js'
import {
  parseShareLink,
  ShareLinkError,
  shareDownload,
  shareKey,
  shareKeyResolver,
  shareOwner,
} from '../common/share-link.js'
import { initializeSynapse, type SynapseSetupConfig } from '../core/synapse/index.js'
import { type CLIAuthOptions, getCLILogger, parseCLIAuth } from '../utils/cli-auth.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'

/** The address whose data sets are searched for providers, if the credentials name one. */
export function addressOf(auth: SynapseSetupConfig): Address | undefined {
  if ('privateKey' in auth && auth.privateKey != null) return privateKeyToAccount(auth.privateKey).address
  if ('walletAddress' in auth && auth.walletAddress != null) return getAddress(auth.walletAddress)
  return undefined
}

/** A read-only client for `address` on the credentials' network: public reads, so no key is used. */
export function readOnlySynapse(auth: SynapseSetupConfig, address: Address, logger: Logger) {
  const readOnly = {
    walletAddress: address,
    readOnly: true as const,
    ...(auth.chain != null && { chain: auth.chain }),
    ...(auth.rpcUrl != null && { rpcUrl: auth.rpcUrl }),
  }
  return initializeSynapse(readOnly, logger)
}

/** Providers of the address's own IPFS-indexed data sets, or with `restricted` its read-gated ones. */
export async function ownProviders(
  auth: SynapseSetupConfig,
  address: Address,
  logger: Logger,
  restricted = false
): Promise<string[]> {
  return ownProviderUrls(await readOnlySynapse(auth, address, logger), logger, restricted)
}

export interface GetCommandOptions extends CLIAuthOptions {
  /** A Share link for this upload: its key replaces the credentials'. */
  share?: string
  /** The share's Access key (fak1_…), when the link does not carry it. */
  accessKey?: string
  /** A private upload's piece CID, fetched from gated `/download/` instead of its root CID. */
  piece?: string
}

export async function runGet(
  cidArg: string | undefined,
  outputDir: string | undefined,
  options: GetCommandOptions
): Promise<void> {
  // With --share the link names the upload, so the CID may be left out: in
  // `get --share <link> ./out`, the lone argument is the output directory.
  if (options.share != null && outputDir == null && cidArg != null && !isCid(cidArg)) {
    outputDir = cidArg
    cidArg = undefined
  }
  intro(pc.bold('Filecoin Pin Get'))
  const spinner = createSpinner()
  const outDir = outputDir ?? '.'
  let outExists = false
  let tempDir: string | undefined
  // The entry get claimed in `outDir`; set synchronously by the claim, so it is known before
  // anything is written into it.
  let claimed: string | undefined
  // Ctrl-C, kill and a closed terminal: clack's spinner exits the process on SIGINT before any
  // `finally` runs. Registered before the spinner starts so they run first.
  const onSignal = (): void => {
    // A cleanup error (a locked file on Windows) must never keep the process from exiting.
    try {
      removeDecryptOutput(outDir, !outExists, claimed)
    } catch {
      // Exit anyway; the next run reports what is left.
    }
    removeTemp(tempDir)
    process.exit(EXIT_CODE_INCOMPLETE)
  }
  const cleanupSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  try {
    const share = options.share == null ? undefined : parseShareLink(options.share)
    let cid: CID
    if (cidArg != null) {
      try {
        cid = CID.parse(cidArg)
      } catch {
        throw new Error(`Not an IPFS root CID: ${cidArg}`)
      }
      if (share != null && !share.rootCid.equals(cid)) {
        throw new ShareLinkError(`The Share link is for ${share.rootCid}, not ${cid}`)
      }
    } else if (share == null) {
      throw new Error('Give the IPFS root CID to fetch, or --share with a Share link')
    } else {
      cid = share.rootCid
    }
    // Before the handler is armed, so it knows whether `outDir` is ours to remove.
    outExists = (await checkOutputDir(outDir)).outExists
    const auth = parseCLIAuth(options)
    const logger = getCLILogger()
    const address = addressOf(auth)
    // Used only when an envelope asks for a key, so plain content needs no credentials.
    let resolveKey = credentialKeyResolver(auth)
    let sharer: Address | undefined
    // A private upload's share: what to fetch, and the right to, from the link.
    let shared: GetOptions['download']
    if (share != null) {
      // Before the download, so a missing or wrong Access key, or an expired share, fails fast.
      const T = shareKey(share, options.accessKey)
      sharer = await shareOwner(share, T)
      resolveKey = shareKeyResolver(share, T)
      // A private upload's link carries the right to fetch it, signed with T.
      shared = await shareDownload(share, T)
    }

    // Without a link: the credentials' own private upload, by --piece or found by its root CID.
    const { piece } = options
    if (piece != null) {
      if (share != null) throw new Error('Choose --piece or --share, not both')
      try {
        CID.parse(piece)
      } catch {
        throw new Error(`Not a piece CID: ${piece}`)
      }
    }
    const privateAccess = share == null && address != null ? await privateAccessOf(auth, address, logger) : undefined
    if (piece != null && privateAccess == null) {
      throw new Error(
        '--piece needs the owner wallet (PRIVATE_KEY) or a session key holding a group key Grant (`filecoin-pin login --group <group>`)'
      )
    }

    const workDir = await mkdtemp(join(tmpdir(), 'filecoin-pin-get-'))
    tempDir = workDir
    for (const signal of cleanupSignals) process.once(signal, onSignal)
    const onClaim = (path: string): void => {
      claimed = path
    }
    const fetchFrom = (sources: ProviderSource[], download?: GetOptions['download']) =>
      getToDirectory(cid, outDir, sources, resolveKey, {
        tempDir: workDir,
        logger,
        onClaim,
        ...(download != null && { download }),
      })

    let result: GetResult | undefined
    // Why the private path failed, when it got as far as a provider: shown only if the public path fails too.
    let privateFailure: string | undefined
    if (shared != null) {
      // A private share is served only on the gated path: by the providers the link names, then the
      // sharer's own read-restricted data sets. Never public, so there is nothing to fall back to.
      const sources: ProviderSource[] = [{ name: 'Share link', find: async () => share?.providers ?? [] }]
      if (sharer != null) {
        sources.push({ name: "Sharer's private data set", find: () => ownProviders(auth, sharer, logger, true) })
      }
      spinner.start('Downloading the shared private upload...')
      result = await fetchFrom(sources, shared)
      spinner.stop()
    } else if (privateAccess != null && address != null) {
      // A private upload is not indexed anywhere: only its own gated data sets serve it, at
      // /download/<root> (or /download/<piece> with --piece), each request signed over that CID.
      spinner.start('Looking among your private uploads...')
      try {
        result = await fetchFrom(
          [{ name: 'Private data set', find: () => ownProviders(auth, address, logger, true) }],
          {
            cid: piece ?? cid.toString(),
            authorizations: privateAccess,
          }
        )
      } catch (error) {
        // Not among them (or none to search): it may still be public. --piece names a private upload only.
        if (piece != null || !(error instanceof NoProviderError || error instanceof FetchFailedError)) throw error
        if (error instanceof FetchFailedError) privateFailure = error.message
        logger.debug({ reason: error.message }, 'Not served from a private data set')
      }
      spinner.stop()
    }
    if (result == null) {
      spinner.start('Finding providers and downloading...')
      const sources: ProviderSource[] = [{ name: 'IPNI', find: (signal) => ipniProviderUrls(cid, { signal }) }]
      // initializeSynapse and listDataSets take no signal; the source deadline still ends the wait.
      if (address != null) sources.push({ name: 'Data set', find: () => ownProviders(auth, address, logger) })
      // The sharer's own data sets: found before IPNI indexes a fresh upload, and on networks without IPNI.
      if (sharer != null && sharer !== address) {
        sources.push({ name: "Sharer's data set", find: () => ownProviders(auth, sharer, logger) })
      }
      try {
        result = await fetchFrom(sources)
      } catch (error) {
        if (privateFailure != null) log.warn(`Your private uploads did not serve it either: ${privateFailure}`)
        throw error
      }
    }
    const what = `${result.files} file${result.files === 1 ? '' : 's'}`
    spinner.stop(
      `${pc.green('✓')} Verified every block from ${result.provider}; ${result.encrypted ? 'decrypted' : 'wrote'} ${what}`
    )
    outro(`Saved to ${result.path}`)
  } catch (error) {
    if (isCliIncomplete(error)) {
      spinner.stop()
      cancel(error.message)
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    spinner.stop(`${pc.red('✗')} Get failed: ${message}`)
    cancel('Get failed')
    // No `cause`: a decrypt error's original may name entries inside the envelope.
    throw new CliFatal(message)
  } finally {
    for (const signal of cleanupSignals) process.off(signal, onSignal)
    removeTemp(tempDir)
  }
}

/**
 * How these credentials fetch a private upload: the owner wallet authorizes itself, a session key
 * presents its Grants. Undefined for credentials that can do neither.
 */
async function privateAccessOf(
  auth: SynapseSetupConfig,
  address: Address,
  logger: Logger
): Promise<Authorizations | undefined> {
  if ('privateKey' in auth && auth.privateKey != null) {
    const synapse = await readOnlySynapse(auth, address, logger)
    return ownerAuthorizations(synapse, privateKeyToAccount(auth.privateKey), logger)
  }
  if ('sessionKey' in auth && auth.sessionKey != null) {
    return grantAuthorizations({ sessionKey: auth.sessionKey, walletAddress: auth.walletAddress }, auth.chain?.id)
  }
  return undefined
}

function isCid(text: string): boolean {
  try {
    CID.parse(text)
    return true
  } catch {
    return false
  }
}

/** Best effort: a temp file left behind must not turn a finished get into a failure. */
function removeTemp(tempDir: string | undefined): void {
  if (tempDir == null) return
  try {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    // Left in the OS temp dir, which the OS cleans.
  }
}
