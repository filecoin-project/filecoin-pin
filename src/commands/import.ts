import { Command } from 'commander'
import { runCarImportFromCli } from '../import/import.js'
import {
  addAuthOptions,
  addAutoFundOptions,
  addContextSelectionOptions,
  addUploadOptions,
} from '../utils/cli-options.js'
import { addEgressOptions } from '../utils/cli-options-egress.js'
import { addMetadataOptions } from '../utils/cli-options-metadata.js'

export const importCommand = new Command('import')
  .description('Import an existing CAR file to Filecoin via Synapse')
  .argument('<file>', 'Path to the CAR file to import')
  .option('--copies <n>', 'Number of storage copies to create (default: 2)', Number.parseInt)
  .action(async (file: string, options) => {
    try {
      const result = await runCarImportFromCli(file, options)
      if (result.copies.length < result.requestedCopies) {
        process.exitCode = 1
      }
    } catch {
      process.exit(1)
    }
  })

addAuthOptions(importCommand)
addContextSelectionOptions(importCommand)
addUploadOptions(importCommand)
addAutoFundOptions(importCommand)
addEgressOptions(importCommand)
addMetadataOptions(importCommand, { includePieceMetadata: true, includeDataSetMetadata: true, includeErc8004: true })
