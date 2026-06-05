import type { Command } from 'commander'
import { addCommand } from './add.js'
import { dataSetCommand } from './data-set.js'
import { importCommand } from './import.js'
import { paymentsCommand } from './payments.js'
import { providerCommand } from './provider.js'
import { removeCommand } from './remove.js'
import { serverCommand } from './server.js'
import { sessionCommand } from './session.js'

export {
  addCommand,
  dataSetCommand,
  importCommand,
  paymentsCommand,
  providerCommand,
  removeCommand,
  serverCommand,
  sessionCommand,
}

/**
 * Every top-level CLI command in the order they're registered on the program.
 *
 * Adding a new command? Append it here. cli.ts and the network-default tests
 * iterate this list, so registration and coverage stay in sync.
 */
export const ALL_CLI_COMMANDS: readonly Command[] = [
  serverCommand,
  paymentsCommand,
  dataSetCommand,
  importCommand,
  addCommand,
  removeCommand,
  providerCommand,
  sessionCommand,
]
