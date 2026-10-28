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
import { credentialKeyResolver } from '../common/group-key-grant.js'
import { ipniProviderUrls, ownProviderUrls, type ProviderSource } from '../common/ipfs-car-fetch.js'
import { getToDirectory } from '../common/ipfs-get.js'
import { parseShareLink, ShareLinkError, shareKey, shareKeyResolver } from '../common/share-link.js'
import { initializeSynapse, type SynapseSetupConfig } from '../core/synapse/index.js'
import { type CLIAuthOptions, getCLILogger, parseCLIAuth } from '../utils/cli-auth.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'

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

/** Providers of the address's own IPFS-indexed data sets. */
export async function ownProviders(auth: SynapseSetupConfig, address: Address, logger: Logger): Promise<string[]> {
  return ownProviderUrls(await readOnlySynapse(auth, address, logger), logger)
}

export interface GetCommandOptions extends CLIAuthOptions {
  /** A Share link for this upload: its key replaces the credentials'. */
  share?: string
  /** The share's Access key (fak1_…), when the link does not carry it. */
  accessKey?: string
  /** The share's password, for a password share. */
  password?: string
}

export async function runGet(cidArg: string, outputDir: string | undefined, options: GetCommandOptions): Promise<void> {
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
    let cid: CID
    try {
      cid = CID.parse(cidArg)
    } catch {
      throw new Error(`Not an IPFS root CID: ${cidArg}`)
    }
    // Before the handler is armed, so it knows whether `outDir` is ours to remove.
    outExists = (await checkOutputDir(outDir)).outExists
    const auth = parseCLIAuth(options)
    const logger = getCLILogger()
    const address = addressOf(auth)
    // Used only when an envelope asks for a key, so plain content needs no credentials.
    let resolveKey = credentialKeyResolver(auth)
    if (options.share != null) {
      const share = parseShareLink(options.share)
      if (!share.rootCid.equals(cid)) {
        throw new ShareLinkError(`The Share link is for ${share.rootCid}, not ${cid}`)
      }
      // Before the download, so a missing or wrong-format secret fails fast.
      resolveKey = shareKeyResolver(share, await shareKey(share, options))
    }

    tempDir = await mkdtemp(join(tmpdir(), 'filecoin-pin-get-'))
    for (const signal of cleanupSignals) process.once(signal, onSignal)
    spinner.start('Finding providers and downloading...')
    const sources: ProviderSource[] = [{ name: 'IPNI', find: (signal) => ipniProviderUrls(cid, { signal }) }]
    // initializeSynapse and listDataSets take no signal; the source deadline still ends the wait.
    if (address != null) sources.push({ name: 'Data set', find: () => ownProviders(auth, address, logger) })
    const onClaim = (path: string): void => {
      claimed = path
    }
    const result = await getToDirectory(cid, outDir, sources, resolveKey, {
      tempDir,
      logger,
      onClaim,
    })
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

/** Best effort: a temp file left behind must not turn a finished get into a failure. */
function removeTemp(tempDir: string | undefined): void {
  if (tempDir == null) return
  try {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    // Left in the OS temp dir, which the OS cleans.
  }
}
