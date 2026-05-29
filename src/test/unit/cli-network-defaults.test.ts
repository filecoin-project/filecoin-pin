import type { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import {
  addCommand,
  dataSetCommand,
  importCommand,
  paymentsCommand,
  providerCommand,
  rmCommand,
  serverCommand,
  sessionCommand,
} from '../../commands/index.js'

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
  ['session', sessionCommand],
]

// Local-only leaves that intentionally skip --network (no chain interaction).
const LOCAL_ONLY_LEAVES = new Set(['session generate'])

const leaves = roots
  .flatMap(([root, cmd]) => leafCommands(cmd).map((leaf) => [`${root} ${leaf.name()}`.trim(), leaf] as const))
  .filter(([label]) => !LOCAL_ONLY_LEAVES.has(label))

describe('CLI --network option', () => {
  it.each(leaves)('%s exposes --network with the supported choices', (label, leaf) => {
    const networkOpt = leaf.options.find((o) => o.long === '--network')
    expect(networkOpt, `${label} missing --network option`).toBeDefined()
    expect(networkOpt?.argChoices).toEqual(['mainnet', 'calibration', 'devnet'])
  })

  it('session revoke is visible and exposes owner auth options', () => {
    const sessionHelp = sessionCommand.helpInformation()
    expect(sessionHelp).toContain('revoke')

    const revokeCommand = sessionCommand.commands.find((cmd) => cmd.name() === 'revoke')
    expect(revokeCommand).toBeDefined()
    const revokeHelp = revokeCommand?.helpInformation() ?? ''
    expect(revokeHelp).toContain('<session-address>')
    expect(revokeHelp).toContain('--private-key')
    expect(revokeHelp).toContain('--network')
    expect(revokeHelp).toContain('--rpc-url')
  })
})
