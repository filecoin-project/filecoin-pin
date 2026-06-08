/**
 * Commander wiring for the `session` command tree.
 *
 * Parses arguments, dispatches to runners in `src/session/`, and maps thrown
 * errors to exit codes. All user-facing output lives in the runners.
 */

import { Command } from 'commander'
import { runSessionAuthorize, runSessionCreate, runSessionGenerate } from '../session/index.js'
import { addOwnerAuthOptions, sessionKeyOption } from '../utils/cli-options.js'

export const sessionCommand = new Command('session').description(
  'Authorize and manage session keys for delegated FWSS access'
)

// session create — single-party: owner generates (or reuses) a session key and
// authorizes it on-chain.
const createCommand = new Command('create')
  .description('Generate (or reuse) a session key and authorize it on-chain')
  .option('--validity-days <days>', 'Number of days the session key should be valid (max 365)', '10')
  .addOption(sessionKeyOption('Reuse an existing session private key'))
  .action(async (options) => {
    try {
      await runSessionCreate(options)
    } catch {
      process.exit(1)
    }
  })
addOwnerAuthOptions(createCommand)
sessionCommand.addCommand(createCommand)

// session authorize <session-address> — two-party owner side: sign login() for
// an externally generated session address.
const authorizeCommand = new Command('authorize')
  .description('Authorize an externally generated session address on-chain (two-party flow)')
  .argument('<session-address>', 'Session address to authorize')
  .option('--validity-days <days>', 'Number of days the authorization is valid (max 365)', '10')
  .action(async (sessionAddress, options) => {
    try {
      await runSessionAuthorize({ ...options, sessionAddress })
    } catch {
      process.exit(1)
    }
  })
addOwnerAuthOptions(authorizeCommand)
sessionCommand.addCommand(authorizeCommand)

// session generate — local-only keypair generation (consumer side of the
// two-party flow). No chain interaction.
const generateCommand = new Command('generate')
  .description('Generate a session keypair locally (no chain interaction; consumer side of the two-party flow)')
  .action(() => {
    runSessionGenerate()
  })
sessionCommand.addCommand(generateCommand)
