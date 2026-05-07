import { Command } from 'commander'
import { runCarImport } from '../import/import.js'
import type { ImportOptions } from '../import/types.js'
import {
  addAuthOptions,
  addAutoFundOptions,
  addContextSelectionOptions,
  addUploadOptions,
  validateAndNormalizeAutoFundOptions,
} from '../utils/cli-options.js'
import { addMetadataOptions, resolveMetadataOptions } from '../utils/cli-options-metadata.js'

export const importCommand = new Command('import')
  .description('Import an existing CAR file to Filecoin via Synapse')
  .argument('<file>', 'Path to the CAR file to import')
  .option('--copies <n>', 'Number of storage copies to create (default: 2)', Number.parseInt)
  .action(async (file: string, options) => {
    let autoFundOptions: ReturnType<typeof validateAndNormalizeAutoFundOptions>
    try {
      autoFundOptions = validateAndNormalizeAutoFundOptions(options)
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }

    try {
      const {
        metadata: _metadata,
        dataSetMetadata: _dataSetMetadata,
        datasetMetadata: _datasetMetadata,
        '8004Type': _erc8004Type,
        '8004Agent': _erc8004Agent,
        autoFund: _autoFund,
        minRunwayDays: _minRunwayDays,
        maxBalance: _maxBalance,
        ...importOptionsFromCli
      } = options

      const { pieceMetadata, dataSetMetadata } = resolveMetadataOptions(options, { includeErc8004: true })
      const importOptions: ImportOptions = {
        ...importOptionsFromCli,
        ...autoFundOptions,
        filePath: file,
        ...(pieceMetadata && { pieceMetadata }),
        ...(dataSetMetadata && { dataSetMetadata }),
      }

      await runCarImport(importOptions)
    } catch {
      process.exit(1)
    }
  })

addAuthOptions(importCommand)
addContextSelectionOptions(importCommand)
addUploadOptions(importCommand)
addAutoFundOptions(importCommand)
addMetadataOptions(importCommand, { includePieceMetadata: true, includeDataSetMetadata: true, includeErc8004: true })
