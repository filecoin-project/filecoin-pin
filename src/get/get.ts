/**
 * Fetch an upload by its IPFS root CID into a new directory, decrypting it when it was
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
import { type OwnerSigner, ownerKeyResolver } from '../common/group-key.js'
import { ipniProviderUrls, ownProviderUrls } from '../common/ipfs-car-fetch.js'
import { getToDirectory } from '../common/ipfs-get.js'
import { initializeSynapse, type SynapseSetupConfig } from '../core/synapse/index.js'
import { type CLIAuthOptions, getCLILogger, parseCLIAuth } from '../utils/cli-auth.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'

/** The address whose data sets are searched for providers, if the credentials name one. */
function addressOf(auth: SynapseSetupConfig): Address | undefined {
  if ('privateKey' in auth && auth.privateKey != null) return privateKeyToAccount(auth.privateKey).address
  if ('walletAddress' in auth && auth.walletAddress != null) return getAddress(auth.walletAddress)
  return undefined
}

/** Providers of the address's own IPFS-indexed data sets; a public read, so no key is used. */
async function ownProviders(auth: SynapseSetupConfig, address: Address, logger: Logger): Promise<string[]> {
  const readOnly = {
    walletAddress: address,
    readOnly: true as const,
    ...(auth.chain != null && { chain: auth.chain }),
    ...(auth.rpcUrl != null && { rpcUrl: auth.rpcUrl }),
  }
  return ownProviderUrls(await initializeSynapse(readOnly, logger), logger)
}

export async function runGet(cidArg: string, outputDir: string | undefined, options: CLIAuthOptions): Promise<void> {
  intro(pc.bold('Filecoin Pin Get'))
  const spinner = createSpinner()
  let outDir = outputDir ?? cidArg
  let outExists = false
  let tempDir: string | undefined
  // Ctrl-C, kill and a closed terminal: clack's spinner exits the process on SIGINT before any
  // `finally` runs. Registered before the spinner starts so they run first.
  const onSignal = (): void => {
    removeDecryptOutput(outDir, !outExists)
    if (tempDir != null) rmSync(tempDir, { recursive: true, force: true })
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
    outDir = outputDir ?? cid.toString()
    // Before the handler is armed: it must never remove entries get would have refused to touch.
    outExists = (await checkOutputDir(outDir)).outExists
    const auth = parseCLIAuth(options)
    const logger = getCLILogger()
    const address = addressOf(auth)
    // Read only when an envelope asks for a key, so plain content needs no credentials.
    const signer = (): OwnerSigner | undefined =>
      'privateKey' in auth && auth.privateKey != null ? privateKeyToAccount(auth.privateKey) : undefined

    tempDir = await mkdtemp(join(tmpdir(), 'filecoin-pin-get-'))
    for (const signal of cleanupSignals) process.once(signal, onSignal)
    spinner.start('Finding providers and downloading...')
    const findProviders = [() => ipniProviderUrls(cid, { logger })]
    if (address != null) findProviders.push(() => ownProviders(auth, address, logger))
    const result = await getToDirectory(cid, outDir, findProviders, ownerKeyResolver(signer), { tempDir, logger })
    const what = `${result.files} file${result.files === 1 ? '' : 's'}`
    spinner.stop(
      `${pc.green('✓')} Verified every block from ${result.provider}; ${result.encrypted ? 'decrypted' : 'wrote'} ${what} to ${outDir}`
    )
    outro('Get complete')
  } catch (error) {
    if (isCliIncomplete(error)) {
      spinner.stop()
      cancel(error.message)
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    spinner.stop(`${pc.red('✗')} Get failed: ${message}`)
    cancel('Get failed')
    throw new CliFatal(message, { cause: error instanceof Error ? error : undefined })
  } finally {
    for (const signal of cleanupSignals) process.off(signal, onSignal)
    if (tempDir != null) rmSync(tempDir, { recursive: true, force: true })
  }
}
