#!/usr/bin/env node
import './instrument.js'
import { Command } from 'commander'
import pc from 'picocolors'

import { addCommand } from './commands/add.js'
import { dataSetCommand } from './commands/data-set.js'
import { importCommand } from './commands/import.js'
import { paymentsCommand } from './commands/payments.js'
import { providerCommand } from './commands/provider.js'
import { rmCommand } from './commands/rm.js'
import { serverCommand } from './commands/server.js'
import { checkForUpdate, type UpdateCheckStatus } from './common/version-check.js'
import { version as packageVersion } from './core/utils/version.js'

// Create the main program
const program = new Command()
  .name('filecoin-pin')
  .description('IPFS Pinning Service with Filecoin storage via Synapse SDK')
  .version(packageVersion)
  .option('-v, --verbose', 'verbose output')
  .option('--no-update-check', 'skip check for updates')

// Add subcommands
program.addCommand(serverCommand)
program.addCommand(paymentsCommand)
program.addCommand(dataSetCommand)
program.addCommand(importCommand)
program.addCommand(addCommand)
program.addCommand(rmCommand)
program.addCommand(providerCommand)

// Default action - show help if no command specified
program.action(() => {
  program.help()
})

let updateCheckResult: UpdateCheckStatus | null = null

program.hook('preAction', () => {
  if (updateCheckResult) {
    return
  }

  const options = program.optsWithGlobals<{ updateCheck?: boolean }>()
  if (options.updateCheck === false) {
    updateCheckResult = null
    return
  }

  setImmediate(() => {
    checkForUpdate({ currentVersion: packageVersion })
      .then((result) => {
        updateCheckResult = result
      })
      .catch(() => {
        // could not check for update, swallow error
        // checkForUpdate should not throw. If it does, it's an unexpected error.
      })
  }).unref()
})

program.hook('postAction', async () => {
  if (updateCheckResult?.status === 'update-available') {
    const result = updateCheckResult
    updateCheckResult = null

    const header = `${pc.yellow(`Update available: filecoin-pin ${result.currentVersion} → ${result.latestVersion}`)}. Upgrade with ${pc.cyan('npm i -g filecoin-pin@latest')}`
    const releasesLink = 'https://github.com/filecoin-project/filecoin-pin/releases'
    const instruction = `Visit ${releasesLink} to view release notes or download the latest version.`
    console.log(header)
    console.log(instruction)
  }
})

// Parse arguments and run
program.parseAsync(process.argv).catch((error) => {
  console.error('Error:', error.message)
  process.exit(1)
})
