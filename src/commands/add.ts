import { Command } from 'commander'
import { runAddFromCli } from '../add/add.js'
import {
  addAuthOptions,
  addAutoFundOptions,
  addContextSelectionOptions,
  addUploadOptions,
} from '../utils/cli-options.js'
import { addMetadataOptions } from '../utils/cli-options-metadata.js'

export const addCommand = new Command('add')
  .description('Add a file or directory to Filecoin via Synapse (creates UnixFS CAR)')
  .argument('<path>', 'Path to the file or directory to add')
  .option('--bare', 'Add file without directory wrapper (files only, not supported for directories)')
  .option('--copies <n>', 'Number of storage copies to create (default: 2)', Number.parseInt)

addCommand.action(async (path: string, options: any) => {
  try {
    const result = await runAddFromCli(path, options)
    if (result.copies.length < result.requestedCopies) {
      process.exitCode = 1
    }
  } catch {
    process.exit(1)
  }
})

addAuthOptions(addCommand)
addContextSelectionOptions(addCommand)
addUploadOptions(addCommand)
addAutoFundOptions(addCommand)
addMetadataOptions(addCommand, { includePieceMetadata: true, includeDataSetMetadata: true, includeErc8004: true })
