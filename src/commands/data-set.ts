import { Command } from 'commander'
import { runDataSetDetailsCommand, runDataSetListCommand } from '../data-set/run.js'
import type { DataSetCommandOptions, DataSetListCommandOptions } from '../data-set/types.js'
import { addAuthOptions, addProviderOptions } from '../utils/cli-options.js'

export const dataSetCommand = new Command('data-set')
  .description('Inspect data sets managed through Filecoin Onchain Cloud')
  .argument('[dataSetId]', 'Display detailed information about a data-set')
  .action(async (dataSetId: string | undefined, options) => {
    if (dataSetId == null) {
      // render help
      dataSetCommand.help()
      process.exit(0)
    }

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
addAuthOptions(dataSetCommand)

export const dataSetListCommand = new Command('list')
  .alias('ls')
  .description('List all data sets for the configured account')
  .action(async (options) => {
    try {
      const commandOptions: DataSetListCommandOptions = {
        ...options,
      }
      await runDataSetListCommand(commandOptions)
    } catch (error) {
      console.error('Data set list command failed:', error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })
addAuthOptions(dataSetListCommand)
addProviderOptions(dataSetListCommand)

dataSetCommand.addCommand(dataSetListCommand)
