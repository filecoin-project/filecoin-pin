import { Command } from 'commander'
import { MIN_RUNWAY_DAYS } from '../common/constants.js'
import { runCarImport } from '../import/import.js'
import type { ImportOptions } from '../import/types.js'
import { addAuthOptions, addProviderOptions } from '../utils/cli-options.js'
import { addMetadataOptions, resolveMetadataOptions } from '../utils/cli-options-metadata.js'

export const importCommand = new Command('import')
  .description('Import an existing CAR file to Filecoin via Synapse')
  .argument('<file>', 'Path to the CAR file to import')
  .option('--auto-fund', `Automatically ensure minimum ${MIN_RUNWAY_DAYS} days of runway before upload`)
  .action(async (file: string, options) => {
    try {
      const { metadata, dataSetMetadata } = resolveMetadataOptions(options, { includeErc8004: true })
      const {
        metadata: _metadata,
        dataSetMetadata: _dataSetMetadata,
        datasetMetadata: _datasetMetadata,
        '8004Type': _erc8004Type,
        '8004Agent': _erc8004Agent,
        ...rest
      } = options
      const importOptions: ImportOptions = {
        ...rest,
        filePath: file,
        ...(metadata ? { metadata } : {}),
        ...(dataSetMetadata ? { dataSetMetadata } : {}),
      }

      await runCarImport(importOptions)
    } catch (error) {
      console.error('Import failed:', error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })

addAuthOptions(importCommand)
addProviderOptions(importCommand)
addMetadataOptions(importCommand, { includePieceMetadata: true, includeDataSetMetadata: true, includeErc8004: true })
