import type { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { addCommand } from '../../commands/add.js'
import { dataSetCommand } from '../../commands/data-set.js'
import { importCommand } from '../../commands/import.js'
import { paymentsCommand } from '../../commands/payments.js'
import { providerCommand } from '../../commands/provider.js'
import { rmCommand } from '../../commands/rm.js'
import { serverCommand } from '../../commands/server.js'

function leafCommands(cmd: Command): Command[] {
  return cmd.commands.length === 0 ? [cmd] : cmd.commands.flatMap(leafCommands)
}

const roots: Array<[string, Command]> = [
  ['add', addCommand],
  ['import', importCommand],
  ['rm', rmCommand],
  ['server', serverCommand],
  ['payments', paymentsCommand],
  ['data-set', dataSetCommand],
  ['provider', providerCommand],
]

const leaves = roots.flatMap(([root, cmd]) =>
  leafCommands(cmd).map((leaf) => [`${root} ${leaf.name()}`.trim(), leaf] as const)
)

describe('CLI --network default', () => {
  it.each(leaves)('%s defaults --network to mainnet', (label, leaf) => {
    const networkOpt = leaf.options.find((o) => o.long === '--network')
    expect(networkOpt, `${label} missing --network option`).toBeDefined()
    expect(networkOpt?.defaultValue).toBe('mainnet')
  })
})
