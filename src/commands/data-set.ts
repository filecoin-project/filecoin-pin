import { Command } from 'commander'
import { runDataSetDetailsCommand, runDataSetListCommand, runTerminateDataSetCommand } from '../data-set/run.js'
import type { DataSetListCommandOptions } from '../data-set/types.js'
import { addAuthOptions } from '../utils/cli-options.js'
import { addMetadataOptions, resolveMetadataOptions } from '../utils/cli-options-metadata.js'

// Strict integer parse: rejects partial matches like "12abc" that
// `Number.parseInt` would accept. Returns NaN for any invalid input so
// runner-side validation reports it via clack.
function parseStrictId(value: string): number {
  const n = Number(value)
  return Number.isInteger(n) ? n : NaN
}

export const dataSetCommand = new Command('data-set')
  .alias('dataset')
  .description('Inspect data sets managed through Filecoin Onchain Cloud')

export const dataSetShowCommand = new Command('show')
  .description('Display detailed information about a data set')
  .argument('<dataSetId>', 'Display detailed information about a data set')
  .action(async (dataSetId: string, options) => {
    try {
      await runDataSetDetailsCommand(parseStrictId(dataSetId), { ...options })
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
dataSetListCommand.option('--provider-id <id>', 'Filter data sets by provider ID')
addMetadataOptions(dataSetListCommand, { includePieceMetadata: false, includeDataSetMetadata: true })

export const dataSetTerminateCommand = new Command('terminate')
  .description('Terminate a data set and associated payment rails')
  .argument('<dataSetId>', 'Data set ID to terminate')
  .option('--wait', 'Wait for the termination transaction to be confirmed')
  .action(async (dataSetId: string, options) => {
    try {
      await runTerminateDataSetCommand(parseStrictId(dataSetId), { ...options })
    } catch {
      process.exit(1)
    }
  })
addAuthOptions(dataSetTerminateCommand)

dataSetCommand.addCommand(dataSetShowCommand)
dataSetCommand.addCommand(dataSetListCommand)
dataSetCommand.addCommand(dataSetTerminateCommand)
