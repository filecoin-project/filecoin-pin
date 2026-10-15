import { Command } from 'commander'
import { EXIT_CODE_INCOMPLETE, isCliIncomplete } from '../common/cli-errors.js'
import { runDecrypt } from '../decrypt/decrypt.js'

export const decryptCommand = new Command('decrypt')
  .description('Decrypt an upload made with `add --encrypt` into a new directory')
  .argument('<file>', 'Encrypted file downloaded from its IPFS Root CID: the bare envelope or the CAR a gateway serves')
  .argument('<output-dir>', 'Directory to write the decrypted file or directory into (created, or must be empty)')
  .option('--password-file <path>', 'Read the password from this file; otherwise FILECOIN_PIN_PASSWORD or a prompt')
  .addHelpText(
    'after',
    `
Download the encrypted file by its IPFS Root CID first.
  Guide: https://github.com/filecoin-project/filecoin-pin/blob/master/documentation/retrieval.md

The upload is restored under its original name inside <output-dir>: a file becomes
<output-dir>/<name>, a directory becomes <output-dir>/<name>/... with its contents.`
  )
  .action(async (file: string, outputDir: string, options: { passwordFile?: string }) => {
    try {
      await runDecrypt(file, outputDir, options)
    } catch (error) {
      process.exit(isCliIncomplete(error) ? EXIT_CODE_INCOMPLETE : 1)
    }
  })
