#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Command } from 'commander'

import { serverCommand } from './commands/server.js'

// Get package.json for version
const __dirname = dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))

// Create the main program
const program = new Command()
  .name('filecoin-pin')
  .description('IPFS Pinning Service with Filecoin storage via Synapse SDK')
  .version(packageJson.version)
  .option('-v, --verbose', 'verbose output')

// Add subcommands
program.addCommand(serverCommand)

// Default action - show help if no command specified
program.action(() => {
  program.help()
})

// Parse arguments and run
program.parseAsync(process.argv).catch((error) => {
  console.error('Error:', error.message)
  process.exit(1)
})
