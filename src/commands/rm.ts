import { Command } from 'commander'
import { runRmPiece } from '../rm/index.js'
import { addAuthOptions } from '../utils/cli-options.js'

export const rmCommand = new Command('rm')
  .description('Remove a Piece from a DataSet')
  .option('--piece <cid>', 'Piece CID to remove')
  .option('--data-set <id>', 'DataSet ID to remove the piece from')
  .option('--wait-for-confirmation', 'Wait for transaction confirmation before exiting')
  .action(async (options) => {
    try {
      await runRmPiece(options)
    } catch {
      // Error already displayed by clack UI in runRmPiece
      process.exit(1)
    }
  })

addAuthOptions(rmCommand)
