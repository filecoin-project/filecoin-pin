/**
 * Decrypt an envelope uploaded with `filecoin-pin add --encrypt` into a directory.
 */

import pc from 'picocolors'
import { CliFatal, EXIT_CODE_INCOMPLETE } from '../common/cli-errors.js'
import { checkDecryptPaths, decryptToDirectory, removeDecryptOutput } from '../common/encryption.js'
import { credentialKeyResolver } from '../common/group-key-grant.js'
import { type CLIAuthOptions, parseCLIAuth } from '../utils/cli-auth.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'

export async function runDecrypt(inputPath: string, outputDir: string, options: CLIAuthOptions): Promise<void> {
  intro(pc.bold('Filecoin Pin Decrypt'))
  const spinner = createSpinner()
  // Ctrl-C, kill and a closed terminal: clack's spinner exits the process on SIGINT before any
  // `finally` runs, which would leave partial plaintext behind. Registered before the spinner
  // starts so they run first.
  let outExists = false
  // The entry decrypt claimed in `outputDir`; set synchronously by the claim, so it is known
  // before anything is written into it.
  let claimed: string | undefined
  const onSignal = (): void => {
    removeDecryptOutput(outputDir, !outExists, claimed)
    process.exit(EXIT_CODE_INCOMPLETE)
  }
  const cleanupSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  try {
    // Before the handler is armed, so it knows whether `outputDir` is ours to remove.
    outExists = (await checkDecryptPaths(inputPath, outputDir)).outExists
    // The owner wallet signs offline for the group key the envelope names, or a session key
    // opens its Grant; no RPC is opened.
    const resolveKey = credentialKeyResolver(parseCLIAuth(options))
    for (const signal of cleanupSignals) process.once(signal, onSignal)
    spinner.start('Decrypting...')
    const { files, path } = await decryptToDirectory(inputPath, outputDir, resolveKey, (entry) => {
      claimed = entry
    })
    spinner.stop(`${pc.green('✓')} Decrypted ${files} file${files === 1 ? '' : 's'}`)
    outro(`Saved to ${path}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    spinner.stop(`${pc.red('✗')} Decrypt failed: ${message}`)
    cancel('Decrypt failed')
    throw new CliFatal(message, { cause: error instanceof Error ? error : undefined })
  } finally {
    for (const signal of cleanupSignals) process.off(signal, onSignal)
  }
}
