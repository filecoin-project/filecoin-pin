#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Command } from 'commander'
import { addCommand } from './commands/add.js'
import { dataSetCommand } from './commands/data-set.js'
import { importCommand } from './commands/import.js'
import { paymentsCommand } from './commands/payments.js'
import { serverCommand } from './commands/server.js'
import { trackFirstRun } from './core/telemetry.js'

// Get package.json for version
const __dirname = dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))

// Create the main program
const program = new Command()
  .name('filecoin-pin')
  .description('IPFS Pinning Service with Filecoin storage via Synapse SDK')
  .version(packageJson.version)
  .option('-v, --verbose', 'verbose output')
  .exitOverride() // Prevent auto-exit so telemetry can complete

// Add subcommands
program.addCommand(serverCommand)
program.addCommand(paymentsCommand)
program.addCommand(dataSetCommand)
program.addCommand(importCommand)
program.addCommand(addCommand)

// Default action - show help if no command specified
program.action(() => {
  program.help()
})

// Track first run for telemetry (non-blocking)
trackFirstRun(packageJson.version)

// Parse arguments and run
try {
  await program.parseAsync(process.argv)
} catch (error) {
  // Commander throws on help/version with exitOverride, ignore those
  if (error instanceof Error && error.message !== '(outputHelp)' && error.message !== '(version)') {
    console.error('Error:', error.message)
    process.exit(1)
  }
}
