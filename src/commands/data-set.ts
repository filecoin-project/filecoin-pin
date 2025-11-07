import { Command } from 'commander'
import { runDataSetDetailsCommand, runDataSetListCommand } from '../data-set/run.js'
import type { DataSetCommandOptions, DataSetListCommandOptions } from '../data-set/types.js'
import { addAuthOptions, addProviderOptions } from '../utils/cli-options.js'

export const dataSetCommand = new Command('data-set').description(
  'Inspect data sets managed through Filecoin Onchain Cloud'
)

export const dataSetShowCommand = new Command('show')
  .description('Display detailed information about a data set')
  .argument('<dataSetId>', 'Display detailed information about a data set')
  .action(async (dataSetId: string, options) => {
    try {
      const commandOptions: DataSetCommandOptions = {
        ...options,
      }
      const dataSetIdNumber = Number.parseInt(dataSetId, 10)
      if (Number.isNaN(dataSetIdNumber)) {
        throw new Error('Invalid data set ID')
      }

      await runDataSetDetailsCommand(dataSetIdNumber, commandOptions)
    } catch (error) {
      console.error('Data set command failed:', error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })
addAuthOptions(dataSetShowCommand)

export const dataSetListCommand = new Command('list')
  .alias('ls')
  .description('List all data sets for the configured account')
  .option('--all', 'Show all data sets, not just the ones created with filecoin-pin', false)
  .action(async (options: DataSetListCommandOptions) => {
    try {
      await runDataSetListCommand(options)
    } catch (error) {
      console.error('Data set list command failed:', error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })
addAuthOptions(dataSetListCommand)
addProviderOptions(dataSetListCommand)

dataSetCommand.addCommand(dataSetShowCommand)
dataSetCommand.addCommand(dataSetListCommand)
