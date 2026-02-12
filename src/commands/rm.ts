import { Command, Option } from 'commander'
import pc from 'picocolors'
import { runRmAllPieces, runRmPiece } from '../rm/index.js'
import { addAuthOptions } from '../utils/cli-options.js'

export const rmCommand = new Command('rm')
  .description('Remove piece(s) from a DataSet')
  .requiredOption('--data-set <id>', 'DataSet ID to remove the piece from')
  .option('--wait-for-confirmation', 'Wait for transaction confirmation before exiting')
  .option('--force', 'Skip confirmation prompt when using --all')

rmCommand.addOption(new Option('--piece <cid>', 'Piece CID to remove').conflicts('all'))
rmCommand.addOption(new Option('--all', 'Remove ALL pieces from the DataSet').conflicts('piece'))

rmCommand.action(async (options) => {
  // Validate: at least one of --piece or --all is required
  if (!options.piece && !options.all) {
    console.error(pc.red('Error: Either --piece or --all is required'))
    process.exit(1)
  }

  try {
    if (options.all) {
      await runRmAllPieces(options)
    } else {
      await runRmPiece(options)
    }
  } catch {
    // Error already displayed by clack UI
    process.exit(1)
  }
})

addAuthOptions(rmCommand)
