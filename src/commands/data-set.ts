import { Command } from 'commander'
import { runDataSetCommand } from '../data-set/run.js'
import type { DataSetCommandOptions } from '../data-set/types.js'
import { addAuthOptions } from '../utils/cli-options.js'

export const dataSetCommand = new Command('data-set')
  .description('Inspect data sets managed through Filecoin Onchain Cloud')
  .argument('[dataSetId]', 'Optional data set ID to inspect')
  .option('--ls', 'List all data sets for the configured account')
  .action(async (dataSetId: string | undefined, options) => {
    try {
      const commandOptions: DataSetCommandOptions = {
        ...options,
        ls: options.ls,
      }

      await runDataSetCommand(dataSetId, commandOptions)
    } catch (error) {
      console.error('Data set command failed:', error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })

addAuthOptions(dataSetCommand)
