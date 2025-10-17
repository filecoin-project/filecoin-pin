import { Command } from 'commander'
import { MIN_RUNWAY_DAYS } from '../common/constants.js'
import { runCarImport } from '../import/import.js'
import type { ImportOptions } from '../import/types.js'
import { addAuthOptions, addProviderOptions } from '../utils/cli-options.js'

export const importCommand = new Command('import')
  .description('Import an existing CAR file to Filecoin via Synapse')
  .argument('<file>', 'Path to the CAR file to import')
  .option('--auto-fund', `Automatically ensure minimum ${MIN_RUNWAY_DAYS} days of runway before upload`)
  .action(async (file: string, options) => {
    try {
      const importOptions: ImportOptions = {
        ...options,
        filePath: file,
        autoFund: options.autoFund,
      }

      await runCarImport(importOptions)
    } catch (error) {
      console.error('Import failed:', error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })

addAuthOptions(importCommand)
addProviderOptions(importCommand)
