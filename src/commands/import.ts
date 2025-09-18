import { RPC_URLS } from '@filoz/synapse-sdk'
import { Command } from 'commander'
import { runCarImport } from '../import/car-import.js'
import type { ImportOptions } from '../import/types.js'

export const importCommand = new Command('import')
  .description('Import an existing CAR file to Filecoin via Synapse')
  .argument('<file>', 'Path to the CAR file to import')
  .option('--private-key <key>', 'Private key for Synapse (or use PRIVATE_KEY env var)')
  .option('--rpc-url <url>', 'RPC URL for Filecoin network', RPC_URLS.calibration.websocket)
  .action(async (file: string, options) => {
    try {
      const importOptions: ImportOptions = {
        filePath: file,
        privateKey: options.privateKey || process.env.PRIVATE_KEY,
        rpcUrl: options.rpcUrl || process.env.RPC_URL,
      }

      await runCarImport(importOptions)
    } catch (error) {
      console.error('Import failed:', error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })
