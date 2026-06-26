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

interface CliCommandGroup {
  heading: string
  commands: readonly Command[]
}

/** Every top-level CLI command, grouped and ordered for help output. */
export const CLI_COMMAND_GROUPS: readonly CliCommandGroup[] = [
  { heading: 'UPLOAD', commands: [addCommand, importCommand] },
  { heading: 'PAYMENTS', commands: [paymentsCommand] },
  { heading: 'MANAGEMENT', commands: [dataSetCommand, providerCommand, removeCommand] },
  { heading: 'ADVANCED', commands: [sessionCommand, serverCommand] },
]
