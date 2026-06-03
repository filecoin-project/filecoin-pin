import type { Command, Option } from 'commander'
import { describe, expect, it } from 'vitest'
import { paymentsCommand } from '../../commands/index.js'

function findSubcommand(name: string): Command {
  const cmd = paymentsCommand.commands.find((c) => c.name() === name)
  if (cmd == null) {
    throw new Error(`payments subcommand "${name}" not found`)
  }
  return cmd
}

function findOption(cmd: Command, long: string): Option {
  const opt = cmd.options.find((o) => o.long === long)
  if (opt == null) {
    throw new Error(`${cmd.name()} is missing option ${long}`)
  }
  return opt
}

// Make a subcommand test-safe: throw instead of exiting on parse errors, and
// swallow the error output Commander writes to stderr.
function parseSafe(cmd: Command, args: string[]): Promise<Command> {
  return cmd
    .exitOverride()
    .configureOutput({ writeErr: () => undefined })
    .parseAsync(args, { from: 'user' })
}

describe('payments day-flag wiring', () => {
  it('fund exposes --target-days and hides the deprecated --days', () => {
    const fund = findSubcommand('fund')
    expect(findOption(fund, '--target-days').hidden).not.toBe(true)
    expect(findOption(fund, '--days').hidden).toBe(true)
  })

  it('deposit exposes --cover-days and hides the deprecated --days', () => {
    const deposit = findSubcommand('deposit')
    expect(findOption(deposit, '--cover-days').hidden).not.toBe(true)
    expect(findOption(deposit, '--days').hidden).toBe(true)
  })

  it('fund help lists --target-days but not the deprecated --days', () => {
    const help = findSubcommand('fund').helpInformation()
    expect(help).toContain('--target-days')
    expect(help).not.toMatch(/(?<!target-)--days\b/)
  })

  it('deposit help lists --cover-days but not the deprecated --days', () => {
    const help = findSubcommand('deposit').helpInformation()
    expect(help).toContain('--cover-days')
    expect(help).not.toMatch(/(?<!cover-)--days\b/)
  })
})

describe('payments deprecated --days conflicts', () => {
  it('fund rejects --target-days together with the deprecated --days', async () => {
    await expect(parseSafe(findSubcommand('fund'), ['--target-days', '10', '--days', '5'])).rejects.toThrow(
      /cannot be used with/
    )
  })

  it('deposit rejects --cover-days together with the deprecated --days', async () => {
    await expect(parseSafe(findSubcommand('deposit'), ['--cover-days', '10', '--days', '5'])).rejects.toThrow(
      /cannot be used with/
    )
  })
})
