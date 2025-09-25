import { RPC_URLS } from '@filoz/synapse-sdk'
import { Command } from 'commander'
import { runAdd } from '../add/add.js'
import type { AddOptions } from '../add/types.js'

export const addCommand = new Command('add')
  .description('Add a file or directory to Filecoin via Synapse (creates UnixFS CAR)')
  .argument('<path>', 'Path to the file or directory to add')
  .option('--private-key <key>', 'Private key for Synapse (or use PRIVATE_KEY env var)')
  .option('--rpc-url <url>', 'RPC URL for Filecoin network', RPC_URLS.calibration.websocket)
  .option('--bare', 'Add file without directory wrapper (files only, not supported for directories)')
  .action(async (path: string, options) => {
    try {
      const addOptions: AddOptions = {
        filePath: path,
        privateKey: options.privateKey || process.env.PRIVATE_KEY,
        rpcUrl: options.rpcUrl || process.env.RPC_URL,
        bare: options.bare,
      }

      await runAdd(addOptions)
    } catch (error) {
      console.error('Add failed:', error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })
