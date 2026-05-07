import type { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { ALL_CLI_COMMANDS } from '../../commands/index.js'

function leafCommands(cmd: Command): Command[] {
  return cmd.commands.length === 0 ? [cmd] : cmd.commands.flatMap(leafCommands)
}

const leaves = ALL_CLI_COMMANDS.flatMap((cmd) =>
  leafCommands(cmd).map((leaf) => [`${cmd.name()} ${leaf.name()}`.trim(), leaf] as const)
)

describe('CLI --network default', () => {
  it.each(leaves)('%s defaults --network to mainnet', (label, leaf) => {
    const networkOpt = leaf.options.find((o) => o.long === '--network')
    expect(networkOpt, `${label} missing --network option`).toBeDefined()
    expect(networkOpt?.defaultValue).toBe('mainnet')
  })
})
