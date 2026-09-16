#!/usr/bin/env node
import './instrument.js'
import { Command, type Help } from 'commander'
import pc from 'picocolors'

import { CLI_COMMAND_GROUPS } from './commands/index.js'
import { checkForUpdate, printUpdateBanner, type UpdateCheckStatus } from './common/version-check.js'
import { configureTelemetry, flushTelemetry } from './core/telemetry/index.js'
import { version as packageVersion } from './core/utils/version.js'
import { readTelemetryConfigFromEnv } from './read-telemetry-config-from-env.js'
import { applyVerboseLogLevel } from './utils/cli-logger.js'
import { credentialsFileOption } from './utils/cli-options.js'
import { applyCredentialsFile } from './utils/credentials-file.js'

// Apply CLI env vars to the telemetry library before any subcommand runs.
configureTelemetry({ ...readTelemetryConfigFromEnv(), affordance: 'CLI' })

function formatTopLevelHelp(command: Command, helper: Help): string {
  const termWidth = helper.padWidth(command, helper)
  const helpWidth = helper.helpWidth ?? 80
  const output: string[] = []
  const formatItem = (term: string, description: string): string =>
    helper.formatItem(term, termWidth, description, helper)
  const formatGroup = (heading: string, items: string[]): void => {
    output.push(...helper.formatItemList(heading, items, helper))
  }

  const description = helper.commandDescription(command)
  if (description.length > 0) {
    output.push(helper.boxWrap(helper.styleCommandDescription(description), helpWidth), '')
  }

  output.push(helper.styleTitle('USAGE'), `  ${helper.styleUsage(helper.commandUsage(command))}`, '')

  const commandGroups = helper.groupItems(
    [...command.commands],
    helper.visibleCommands(command),
    (subcommand) => subcommand.helpGroup() || 'COMMANDS'
  )
  for (const [heading, commands] of commandGroups) {
    const items = commands.map((subcommand) =>
      formatItem(
        helper.styleSubcommandTerm(helper.subcommandTerm(subcommand)),
        helper.styleSubcommandDescription(helper.subcommandDescription(subcommand))
      )
    )
    formatGroup(heading, items)
  }

  const optionGroups = helper.groupItems(
    [...command.options],
    helper.visibleOptions(command),
    (option) => option.helpGroupHeading ?? 'OPTIONS'
  )
  for (const [heading, options] of optionGroups) {
    const items = options.map((option) =>
      formatItem(
        helper.styleOptionTerm(helper.optionTerm(option)),
        helper.styleOptionDescription(helper.optionDescription(option))
      )
    )
    formatGroup(heading, items)
  }

  return output.join('\n')
}

// Create the main program
const program = new Command()
  .name('filecoin-pin')
  .description('IPFS Pinning Service with Filecoin storage')
  .optionsGroup('OPTIONS')
  .version(packageVersion)
  // Registered at the root so the flag is accepted in any position:
  // Commander propagates parent options to subcommands. The preAction hook
  // below is the consumer. Subcommand registrations exist for per-command
  // help visibility.
  .addOption(credentialsFileOption())
  .option('-v, --verbose', 'enable debug-level logging (sets LOG_LEVEL=debug)')
  .option('--no-update-check', 'skip check for updates')
  .helpOption(true)
  .configureHelp({
    formatHelp: formatTopLevelHelp,
    styleTitle: (str) => pc.bold(str.replace(/:$/, '')),
  })
  .addHelpText(
    'after',
    () => `
${pc.bold('EXAMPLES')}
  $ filecoin-pin login                       # approve a session key for this machine in the console
  $ filecoin-pin add ./myfile.txt
  $ filecoin-pin balance
  $ filecoin-pin payments setup --auto        # with a wallet private key instead of login
  $ filecoin-pin import ./archive.car
  $ filecoin-pin dataset ls

${pc.bold('CREDENTIALS')}
  Resolved in this order: flags, then PRIVATE_KEY or SESSION_KEY + WALLET_ADDRESS
  in the environment, then --credentials-file, then the login session saved by
  \`filecoin-pin login\`. VIEW_ADDRESS forces read-only mode and skips the saved login.

${pc.bold('EXIT CODES')}
  0  success
  1  error (the operation failed)
  2  incomplete (the operation neither succeeded nor failed: a confirmation
     was declined, or a requested confirmation wait timed out after submission)

${pc.bold('DOCUMENTATION')}
  https://docs.filecoin.cloud/getting-started/filecoin-pin/`
  )

// Add subcommands
for (const { heading, commands } of CLI_COMMAND_GROUPS) {
  program.commandsGroup(heading)
  for (const command of commands) {
    program.addCommand(command)
  }
}

// Default action - show help if no command specified
program.action(() => {
  program.help()
})

// Credential precedence: flags, then env vars, then --credentials-file, then
// the session file `login` wrote. Flags and env vars are resolved by parsing;
// this hook supplies the credentials file next, and the addAuthOptions hook
// (root hooks run first) supplies the saved login last. A bad file surfaces
// through parseAsync's catch below.
program.hook('preAction', (_thisCommand, actionCommand) => {
  applyCredentialsFile(actionCommand)
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
