import type { Command, Option } from 'commander'
import { describe, expect, it, vi } from 'vitest'
import { paymentsCommand } from '../../commands/index.js'

function findSubcommand(cmd: Command, name: string): Command {
  const sub = cmd.commands.find((c) => c.name() === name)
  if (sub == null) {
    throw new Error(`payments subcommand "${name}" not found`)
  }
  return sub
}

function findOption(cmd: Command, long: string): Option {
  const opt = cmd.options.find((o) => o.long === long)
  if (opt == null) {
    throw new Error(`${cmd.name()} is missing option ${long}`)
  }
  return opt
}

// Parsing mutates the command (exitOverride/configureOutput) and runs its
// action, so import a fresh copy of the command tree to avoid leaking state
// onto the shared `paymentsCommand` singleton other test files import.
async function freshSubcommand(name: string): Promise<Command> {
  vi.resetModules()
  const { paymentsCommand: fresh } = await import('../../commands/index.js')
  return findSubcommand(fresh, name)
    .exitOverride()
    .configureOutput({ writeErr: () => undefined })
}

describe('payments day-flag wiring', () => {
  it('fund exposes --target-days and hides the deprecated --days', () => {
    const fund = findSubcommand(paymentsCommand, 'fund')
    expect(findOption(fund, '--target-days').hidden).not.toBe(true)
    expect(findOption(fund, '--days').hidden).toBe(true)
  })

  it('deposit exposes --cover-days and hides the deprecated --days', () => {
    const deposit = findSubcommand(paymentsCommand, 'deposit')
    expect(findOption(deposit, '--cover-days').hidden).not.toBe(true)
    expect(findOption(deposit, '--days').hidden).toBe(true)
  })

  it('fund help lists --target-days but not the deprecated --days', () => {
    const help = findSubcommand(paymentsCommand, 'fund').helpInformation()
    expect(help).toContain('--target-days')
    expect(help).not.toMatch(/(?<!target-)--days\b/)
  })

  it('deposit help lists --cover-days but not the deprecated --days', () => {
    const help = findSubcommand(paymentsCommand, 'deposit').helpInformation()
    expect(help).toContain('--cover-days')
    expect(help).not.toMatch(/(?<!cover-)--days\b/)
  })
})

describe('payments deprecated --days conflicts', () => {
  it('fund rejects --target-days together with the deprecated --days', async () => {
    const fund = await freshSubcommand('fund')
    await expect(fund.parseAsync(['--target-days', '10', '--days', '5'], { from: 'user' })).rejects.toThrow(
      /cannot be used with/
    )
  })

  it('deposit rejects --cover-days together with the deprecated --days', async () => {
    const deposit = await freshSubcommand('deposit')
    await expect(deposit.parseAsync(['--cover-days', '10', '--days', '5'], { from: 'user' })).rejects.toThrow(
      /cannot be used with/
    )
  })
})
