#!/usr/bin/env node
import './instrument.js'
import { Command } from 'commander'

import { ALL_CLI_COMMANDS } from './commands/index.js'
import { checkForUpdate, printUpdateBanner, type UpdateCheckStatus } from './common/version-check.js'
import { configureTelemetry, flushTelemetry } from './core/telemetry/index.js'
import { version as packageVersion } from './core/utils/version.js'
import { readTelemetryConfigFromEnv } from './read-telemetry-config-from-env.js'
import { applyVerboseLogLevel } from './utils/cli-logger.js'

// Apply CLI env vars to the telemetry library before any subcommand runs.
configureTelemetry({ ...readTelemetryConfigFromEnv(), affordance: 'CLI' })

// Create the main program
const program = new Command()
  .name('filecoin-pin')
  .description('IPFS Pinning Service with Filecoin storage via Synapse SDK')
  .version(packageVersion)
  .option('-v, --verbose', 'enable debug-level logging (sets LOG_LEVEL=debug)')
  .option('--no-update-check', 'skip check for updates')

// Add subcommands
for (const command of ALL_CLI_COMMANDS) {
  program.addCommand(command)
}

// Default action - show help if no command specified
program.action(() => {
  program.help()
})

// Wire the global `-v/--verbose` flag to the log level before each action runs.
program.hook('preAction', () => {
  applyVerboseLogLevel(program.optsWithGlobals<{ verbose?: boolean }>().verbose)
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

program.hook('postAction', async (_thisCommand, actionCommand) => {
  if (updateCheckResult != null) {
    const result = updateCheckResult
    updateCheckResult = null
    printUpdateBanner(result)
  }

  // Viem's WebSocket transport holds persistent connections (with keepAlive
  // and auto-reconnect) that prevent the Node.js event loop from draining.
  // There is no clean way to close these from the outside -- viem's close()
  // triggers reconnect, and the Synapse SDK wraps transports in custom()
  // which hides the underlying socket. The server command manages its own
  // lifecycle via SIGINT/SIGTERM, so only force-exit for CLI commands.
  if (actionCommand.name() !== 'server') {
    try {
      await flushTelemetry()
    } catch (err) {
      // Never let a telemetry flush failure block the forced exit below.
      console.error('Telemetry flush failed:', err)
    } finally {
      process.exit(process.exitCode ?? 0)
    }
  }
})

// Parse arguments and run
program.parseAsync(process.argv).catch((error) => {
  console.error('Error:', error.message)
  process.exit(1)
})
