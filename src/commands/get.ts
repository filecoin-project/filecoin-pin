import { Command, Option } from 'commander'
import { EXIT_CODE_INCOMPLETE, isCliIncomplete } from '../common/cli-errors.js'
import { type GetCommandOptions, runGet } from '../get/get.js'
import { addAuthOptions } from '../utils/cli-options.js'

export const getCommand = new Command('get')
  .description('Fetch an upload by its IPFS root CID into a directory, decrypting it if encrypted.')
  .argument(
    '[cid]',
    'IPFS Root CID of the upload (for an encrypted upload, its Encrypted root CID); optional with --share'
  )
  .argument('[output-dir]', 'Directory to save into (created if missing; may hold other files; default: .)')
  .option(
    '--share <link>',
    'Fetch and decrypt the piece a Share link (from get-share-link) names, instead of using your own credentials'
  )
  .addOption(
    new Option('--access-key <key>', "The Share link's Access key (fak1_…), unless the link carries it").env(
      'SHARE_ACCESS_KEY'
    )
  )
  .addHelpText(
    'after',
    `
Providers are found through IPNI (cid.contact) and, when an address is known (PRIVATE_KEY,
WALLET_ADDRESS or VIEW_ADDRESS), the providers of that address's own data sets; with --share,
also the sharer's. Every block
is verified against the CID before anything is written; a bad download is discarded and the
next provider is tried.

A plain file or folder is saved as <output-dir>/<cid> (its DAG holds no name). An encrypted
upload is decrypted with the owner wallet (PRIVATE_KEY), a session key's group key Grant, or
--share with its Access key, and restored under its original name.
Nothing in <output-dir> is overwritten: a taken name is numbered like a browser download
(<cid> -> "<cid>(1)", report.pdf -> "report(1).pdf"). Plain content needs no credentials.`
  )

addAuthOptions(getCommand)

getCommand.action(async (cid: string | undefined, outputDir: string | undefined, options: GetCommandOptions) => {
  try {
    await runGet(cid, outputDir, options)
  } catch (error) {
    process.exit(isCliIncomplete(error) ? EXIT_CODE_INCOMPLETE : 1)
  }
})
