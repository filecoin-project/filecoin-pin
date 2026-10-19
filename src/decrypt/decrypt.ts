/**
 * Decrypt an envelope uploaded with `filecoin-pin add --encrypt` into a new directory.
 */

import pc from 'picocolors'
import { CliFatal, EXIT_CODE_INCOMPLETE, isCliIncomplete } from '../common/cli-errors.js'
import { checkDecryptPaths, decryptToDirectory, removeDecryptOutput, resolvePassword } from '../common/encryption.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'

export async function runDecrypt(
  inputPath: string,
  outputDir: string,
  options: { passwordFile?: string }
): Promise<void> {
  intro(pc.bold('Filecoin Pin Decrypt'))
  const spinner = createSpinner()
  // Ctrl-C: clack's spinner exits the process on SIGINT before any `finally` runs, which would
  // leave partial plaintext behind. Registered before the spinner starts so it runs first.
  let outExists = false
  const onSigint = (): void => {
    removeDecryptOutput(outputDir, !outExists)
    process.exit(EXIT_CODE_INCOMPLETE)
  }
  try {
    // Before the handler is armed: it must never remove entries decrypt would have refused to touch.
    outExists = (await checkDecryptPaths(inputPath, outputDir)).outExists
    const password = await resolvePassword(options.passwordFile)
    process.once('SIGINT', onSigint)
    spinner.start('Decrypting...')
    const { files, dirs } = await decryptToDirectory(inputPath, outputDir, password)
    const what = files === 1 && dirs === 0 ? '1 file' : `${files} file${files === 1 ? '' : 's'}`
    spinner.stop(`${pc.green('✓')} Decrypted ${what} to ${outputDir}`)
    outro('Decrypt complete')
  } catch (error) {
    if (isCliIncomplete(error)) {
      spinner.stop()
      cancel(error.message)
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    spinner.stop(`${pc.red('✗')} Decrypt failed: ${message}`)
    cancel('Decrypt failed')
    throw new CliFatal(message, { cause: error instanceof Error ? error : undefined })
  } finally {
    process.off('SIGINT', onSigint)
  }
}
