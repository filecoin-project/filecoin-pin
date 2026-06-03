import type { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { paymentsCommand } from '../../commands/index.js'

// Grab a payments subcommand and make it test-safe: throw instead of exiting
// on parse errors, and swallow the error output Commander writes to stderr.
function subcommand(name: string): Command {
  const cmd = paymentsCommand.commands.find((c) => c.name() === name)
  if (cmd == null) {
    throw new Error(`payments subcommand "${name}" not found`)
  }
  return cmd.exitOverride().configureOutput({ writeErr: () => undefined })
}

describe('payments deprecated --days conflicts', () => {
  it('payments fund rejects --target-days together with the deprecated --days', async () => {
    const fund = subcommand('fund')
    await expect(fund.parseAsync(['--target-days', '10', '--days', '5'], { from: 'user' })).rejects.toThrow(
      /cannot be used with/
    )
  })

  it('payments deposit rejects --cover-days together with the deprecated --days', async () => {
    const deposit = subcommand('deposit')
    await expect(deposit.parseAsync(['--cover-days', '10', '--days', '5'], { from: 'user' })).rejects.toThrow(
      /cannot be used with/
    )
  })
})
