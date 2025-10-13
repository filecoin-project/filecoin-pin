import { RPC_URLS } from '@filoz/synapse-sdk'
import { Command } from 'commander'
import { runDataSetCommand } from '../data-set/run.js'
import type { DataSetCommandOptions } from '../data-set/types.js'

export const dataSetCommand = new Command('data-set')
  .description('Inspect data sets managed through Filecoin Onchain Cloud')
  .argument('[dataSetId]', 'Optional data set ID to inspect')
  .option('--ls', 'List all data sets for the configured account')
  .option('--private-key <key>', 'Private key for standard auth (or PRIVATE_KEY env)')
  .option('--wallet-addr <address>', 'Wallet address for session key auth (or WALLET_ADDRESS env)')
  .option('--session-key <key>', 'Session key for session key auth (or SESSION_KEY env)')
  .option('--rpc-url <url>', 'RPC endpoint (or RPC_URL env)', RPC_URLS.calibration.websocket)
  .action(async (dataSetId: string | undefined, options) => {
    try {
      const commandOptions: DataSetCommandOptions = {
        ls: options.ls,
        privateKey: options.privateKey || process.env.PRIVATE_KEY,
        walletAddress: options.walletAddr || process.env.WALLET_ADDRESS,
        sessionKey: options.sessionKey || process.env.SESSION_KEY,
        rpcUrl: options.rpcUrl || process.env.RPC_URL,
      }

      await runDataSetCommand(dataSetId, commandOptions)
    } catch (error) {
      console.error('Data set command failed:', error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })
