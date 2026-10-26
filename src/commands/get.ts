import { Command } from 'commander'
import { EXIT_CODE_INCOMPLETE, isCliIncomplete } from '../common/cli-errors.js'
import { runGet } from '../get/get.js'
import type { CLIAuthOptions } from '../utils/cli-auth.js'
import { addAuthOptions } from '../utils/cli-options.js'

export const getCommand = new Command('get')
  .description('Fetch an upload by its IPFS root CID into a directory, decrypting it if encrypted.')
  .argument('<cid>', 'IPFS Root CID of the upload (for an encrypted upload, its Encrypted root CID)')
  .argument('[output-dir]', 'Directory to save into (created if missing; may hold other files; default: .)')
  .addHelpText(
    'after',
    `
Providers are found through IPNI (cid.contact) and, when an address is known (PRIVATE_KEY,
WALLET_ADDRESS or VIEW_ADDRESS), the providers of that address's own data sets. Every block
is verified against the CID before anything is written; a bad download is discarded and the
next provider is tried.

A plain file or folder is saved as <output-dir>/<cid> (its DAG holds no name). An encrypted
upload is decrypted with the owner wallet (PRIVATE_KEY) and restored under its original name.
Nothing in <output-dir> is overwritten: a taken name is numbered like a browser download
(<cid> -> "<cid>(1)", report.pdf -> "report(1).pdf"). Plain content needs no credentials.`
  )

addAuthOptions(getCommand)

getCommand.action(async (cid: string, outputDir: string | undefined, options: CLIAuthOptions) => {
  try {
    await runGet(cid, outputDir, options)
  } catch (error) {
    process.exit(isCliIncomplete(error) ? EXIT_CODE_INCOMPLETE : 1)
  }
})
