import { Command, Option } from 'commander'
import pc from 'picocolors'
import { runRmAllPieces, runRmPiece } from '../rm/index.js'
import { parseDataSetIdSelection } from '../utils/cli-auth.js'
import { log } from '../utils/cli-logger.js'
import { addAuthOptions, addDataSetIdOption } from '../utils/cli-options.js'

export const removeCommand = new Command('remove')
  .alias('rm')
  .description('Remove stored pieces from your data sets')
  .option('--wait', 'Wait for transaction confirmation before exiting')
  .option('--force', 'Skip confirmation prompt when using --all')

removeCommand.addOption(new Option('--piece <cid>', 'Piece CID to remove').conflicts('all'))
removeCommand.addOption(new Option('--all', 'Remove ALL pieces from the DataSet').conflicts('piece'))
removeCommand.addOption(new Option('--wait-for-confirmation', 'Deprecated alias for --wait').hideHelp())

removeCommand.action(async (options) => {
  // Validate: at least one of --piece or --all is required.
  // This is a routing decision for the wrapper (which runner to dispatch to),
  // so it lives here rather than in either runner.
  if (!options.piece && !options.all) {
    log.line(pc.red('Error: Either --piece or --all is required'))
    log.flush()
    process.exit(1)
  }

  // --wait is canonical; --wait-for-confirmation is a deprecated alias.
  if (options.waitForConfirmation) {
    log.warn('--wait-for-confirmation is deprecated; use --wait instead.')
  }
  const waitForConfirmation = Boolean(options.wait || options.waitForConfirmation)

  let dataSetIds: bigint[]
  try {
    dataSetIds = parseDataSetIdSelection(options)
  } catch (error) {
    log.line(pc.red(`Error: ${error instanceof Error ? error.message : String(error)}`))
    log.flush()
    process.exit(1)
  }

  if (dataSetIds.length === 0) {
    log.line(pc.red('Error: At least one --data-set-id is required'))
    log.flush()
    process.exit(1)
  }

  // Each runner operates on a single dataset; loop so a failure on one dataset
  // does not abort the others, then surface a non-zero exit if any failed.
  let hadFailure = false
  for (const id of dataSetIds) {
    try {
      if (options.all) {
        await runRmAllPieces({ ...options, dataSet: String(id), waitForConfirmation })
      } else {
        await runRmPiece({ ...options, dataSet: String(id), waitForConfirmation })
      }
    } catch {
      // Error already displayed by clack UI
      hadFailure = true
    }
  }

  if (hadFailure) {
    process.exit(1)
  }
})

addAuthOptions(removeCommand)
addDataSetIdOption(removeCommand, { includeSingleAlias: true })
