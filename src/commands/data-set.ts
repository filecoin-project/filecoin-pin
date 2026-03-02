import { Command } from 'commander'
import { runDataSetDetailsCommand, runDataSetListCommand, runTerminateDataSetCommand } from '../data-set/run.js'
import type { DataSetCommandOptions, DataSetListCommandOptions } from '../data-set/types.js'
import { addAuthOptions, addProviderOptions } from '../utils/cli-options.js'
import { addMetadataOptions, resolveMetadataOptions } from '../utils/cli-options-metadata.js'

export const dataSetCommand = new Command('data-set')
  .alias('dataset')
  .description('Inspect data sets managed through Filecoin Onchain Cloud')

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
    } catch {
      process.exit(1)
    }
  })
addAuthOptions(dataSetShowCommand)

export const dataSetListCommand = new Command('list')
  .alias('ls')
  .description('List all data sets for the configured account')
  .option('--all', 'Show all data sets, not just the ones created with filecoin-pin', false)
  .action(async (options) => {
    try {
      const {
        dataSetMetadata: _dataSetMetadata,
        datasetMetadata: _datasetMetadata,
        ...dataSetListOptionsFromCli
      } = options
      const { dataSetMetadata } = resolveMetadataOptions(options)
      const normalizedOptions: DataSetListCommandOptions = {
        ...dataSetListOptionsFromCli,
        ...(dataSetMetadata ? { dataSetMetadata } : {}),
      }
      await runDataSetListCommand(normalizedOptions)
    } catch {
      process.exit(1)
    }
  })
addAuthOptions(dataSetListCommand)
addProviderOptions(dataSetListCommand)
addMetadataOptions(dataSetListCommand, { includePieceMetadata: false, includeDataSetMetadata: true })

export const dataSetTerminateCommand = new Command('terminate')
  .description('Terminate a data set and associated payment rails')
  .argument('<dataSetId>', 'Data set ID to terminate')
  .option('--wait', 'Wait for the termination transaction to be confirmed')
  .action(async (dataSetId: string, options) => {
    try {
      const commandOptions: DataSetCommandOptions = {
        ...options,
      }
      const dataSetIdNumber = Number.parseInt(dataSetId, 10)
      if (Number.isNaN(dataSetIdNumber)) {
        throw new Error('Invalid data set ID')
      }

      await runTerminateDataSetCommand(dataSetIdNumber, commandOptions)
    } catch {
      process.exit(1)
    }
  })
addAuthOptions(dataSetTerminateCommand)

dataSetCommand.addCommand(dataSetShowCommand)
dataSetCommand.addCommand(dataSetListCommand)
dataSetCommand.addCommand(dataSetTerminateCommand)
