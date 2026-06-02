#!/usr/bin/env node
import './instrument.js'
import { Command } from 'commander'
import pc from 'picocolors'

import { ALL_CLI_COMMANDS } from './commands/index.js'
import { checkForUpdate, type UpdateCheckStatus } from './common/version-check.js'
import { configureTelemetry, flushTelemetry } from './core/telemetry/index.js'
import { version as packageVersion } from './core/utils/version.js'
import { readTelemetryConfigFromEnv } from './read-telemetry-config-from-env.js'

// Apply CLI env vars to the telemetry library before any subcommand runs.
configureTelemetry({ ...readTelemetryConfigFromEnv(), affordance: 'CLI' })

// Create the main program
const program = new Command()
  .name('filecoin-pin')
  .description('IPFS Pinning Service with Filecoin storage via Synapse SDK')
  .version(packageVersion)
  .option('-v, --verbose', 'verbose output')
  .option('--no-update-check', 'skip check for updates')

// Add subcommands
for (const command of ALL_CLI_COMMANDS) {
  program.addCommand(command)
}

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

program.hook('postAction', async (_thisCommand, actionCommand) => {
  if (updateCheckResult?.status === 'update-available') {
    const result = updateCheckResult
    updateCheckResult = null

    const header = `${pc.yellow(`Update available: filecoin-pin ${result.currentVersion} → ${result.latestVersion}`)}. Upgrade with ${pc.cyan('npm i -g filecoin-pin@latest')}`
    const releasesLink = 'https://github.com/filecoin-project/filecoin-pin/releases'
    const instruction = `Visit ${releasesLink} to view release notes or download the latest version.`
    console.log(header)
    console.log(instruction)
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
