import { RPC_URLS } from '@filoz/synapse-sdk'
import { Command } from 'commander'
import { MIN_RUNWAY_DAYS } from '../common/constants.js'
import { runCarImport } from '../import/import.js'
import type { ImportOptions } from '../import/types.js'

export const importCommand = new Command('import')
  .description('Import an existing CAR file to Filecoin via Synapse')
  .argument('<file>', 'Path to the CAR file to import')
  .option('--private-key <key>', 'Private key for Synapse (or use PRIVATE_KEY env var)')
  .option('--rpc-url <url>', 'RPC URL for Filecoin network', RPC_URLS.calibration.websocket)
  .option('--auto-fund', `Automatically ensure minimum ${MIN_RUNWAY_DAYS} days of runway before upload`)
  .action(async (file: string, options) => {
    try {
      const importOptions: ImportOptions = {
        filePath: file,
        privateKey: options.privateKey || process.env.PRIVATE_KEY,
        rpcUrl: options.rpcUrl || process.env.RPC_URL,
        autoFund: options.autoFund,
      }

      await runCarImport(importOptions)
    } catch (error) {
      console.error('Import failed:', error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })
