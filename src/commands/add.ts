import { Command, Option } from 'commander'
import { runAdd } from '../add/add.js'
import type { AddOptions } from '../add/types.js'
import { MIN_RUNWAY_DAYS } from '../common/constants.js'
import { addAuthOptions, addProviderOptions } from '../utils/cli-options.js'
import { addMetadataOptions, resolveMetadataOptions } from '../utils/cli-options-metadata.js'

export const addCommand = new Command('add')
  .description('Add a file or directory to Filecoin via Synapse (creates UnixFS CAR)')
  .argument('<path>', 'Path to the file or directory to add')
  .option('--bare', 'Add file without directory wrapper (files only, not supported for directories)')
  .option('--auto-fund', `Automatically ensure minimum ${MIN_RUNWAY_DAYS} days of runway before upload`)

// Add data set selection options
addCommand.addOption(
  new Option('--data-set <id>', 'ID of the existing data set to use')
    .conflicts(['newDataSet', 'new-data-set'])
)

addCommand.addOption(
  new Option('--new-data-set', 'Create a new data set instead of using an existing one')
    .conflicts(['dataSet', 'data-set'])
)

addCommand.action(async (path: string, options: any) => {
  try {
    const {
      metadata: _metadata,
      dataSetMetadata: _dataSetMetadata,
      datasetMetadata: _datasetMetadata,
      '8004Type': _erc8004Type,
      '8004Agent': _erc8004Agent,
      dataSet,
      newDataSet,
      ...addOptionsFromCli
    } = options
    const { pieceMetadata, dataSetMetadata } = resolveMetadataOptions(options, { includeErc8004: true })

    // Normalize dataSet ID
    const rawDataSetId = dataSet
    let dataSetId: number | undefined

    if (rawDataSetId) {
      dataSetId = parseInt(rawDataSetId, 10)
      if (isNaN(dataSetId) || dataSetId < 0 || dataSetId.toString() !== rawDataSetId) {
        console.error('Error: Data set ID must be a valid positive integer')
        process.exit(1)
      }
    }

    const addOptions: AddOptions = {
      ...addOptionsFromCli,
      filePath: path,
      ...(dataSetId !== undefined && { dataSetId }),
      ...(newDataSet && { createNewDataSet: true }),
      ...(pieceMetadata && { pieceMetadata }),
      ...(dataSetMetadata && { dataSetMetadata }),
    }

    await runAdd(addOptions)
  } catch {
    process.exit(1)
  }
})

addAuthOptions(addCommand)
addProviderOptions(addCommand)
addMetadataOptions(addCommand, { includePieceMetadata: true, includeDataSetMetadata: true, includeErc8004: true })
