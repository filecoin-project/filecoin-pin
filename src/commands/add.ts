import { Command } from 'commander'
import { runAdd } from '../add/add.js'
import type { AddOptions } from '../add/types.js'
import { MIN_RUNWAY_DAYS } from '../common/constants.js'
import { addAuthOptions } from '../utils/cli-options.js'

export const addCommand = new Command('add')
  .description('Add a file or directory to Filecoin via Synapse (creates UnixFS CAR)')
  .argument('<path>', 'Path to the file or directory to add')
  .option('--bare', 'Add file without directory wrapper (files only, not supported for directories)')
  .option('--auto-fund', `Automatically ensure minimum ${MIN_RUNWAY_DAYS} days of runway before upload`)
  .action(async (path: string, options) => {
    try {
      const addOptions: AddOptions = {
        ...options,
        filePath: path,
        bare: options.bare,
        autoFund: options.autoFund,
      }

      await runAdd(addOptions)
    } catch (error) {
      console.error('Add failed:', error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })

addAuthOptions(addCommand)
