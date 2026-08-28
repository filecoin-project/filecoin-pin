/**
 * CLI error-scenario smoke test matrix
 * ─────────────────────────────────────
 * Issue: https://github.com/filecoin-project/filecoin-pin/issues/470
 *
 * Every test here exercises an error path that does NOT require a live RPC
 * connection (two-layer error model):
 *
 *   Layer 1 — Commander.js: missing required args.
 *             Exits synchronously before any app code runs.
 *
 *   Layer 2 — Command wiring (src/commands/<cmd>.ts): auth failures,
 *             argument-value validation. Runner throws → command wiring
 *             catches, prints to stderr/stdout, exits 1.
 *
 * Scope: CI-safe, no-network, no-auth subset only.
 * Network-dependent scenarios are deferred to PR 2.
 *
 * Adding a new scenario
 * ──────────────────────
 * 1. Find or create the describe() block for the command.
 * 2. Add an it() with a label that names the exact failure mode.
 * 3. Assert exitCode and one toContain() for the key error phrase.
 */

import { describe, expect, it } from 'vitest'
import { runCli } from './utils.js'

const T = { timeout: 30_000 } as const

// ═══════════════════════════════════════════════════════════════════════════
// Global CLI behaviour
// ═══════════════════════════════════════════════════════════════════════════

describe('global CLI behaviour', () => {
  it('--help exits 0 and lists core commands', T, async () => {
    const result = await runCli(['--help'])
    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain('add')
    expect(result.combined).toContain('import')
    expect(result.combined).toContain('payments')
    expect(result.combined).toContain('data-set')
    expect(result.combined).toContain('provider')
    expect(result.combined).toContain('session')
  })

  it('--version exits 0 and prints a semver string', T, async () => {
    const result = await runCli(['--version'])
    expect(result.exitCode).toBe(0)
    expect(result.combined.trim()).toMatch(/\d+\.\d+\.\d+/)
  })

  it('unknown command', T, async () => {
    const result = await runCli(['unknown-command'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('too many arguments')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// add
// ═══════════════════════════════════════════════════════════════════════════

describe('add', () => {
  it('missing required path argument', T, async () => {
    const result = await runCli(['add'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain("missing required argument 'path'")
  })

  it('non-existent file path', T, async () => {
    const result = await runCli(['add', 'non-existent-file.txt'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('Path not found: non-existent-file.txt')
  })

  it('no auth — valid path, PRIVATE_KEY absent', T, async () => {
    const result = await runCli(['add', 'package.json'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('No authentication provided')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// import
// ═══════════════════════════════════════════════════════════════════════════

describe('import', () => {
  it('missing required file argument', T, async () => {
    const result = await runCli(['import'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain("missing required argument 'file'")
  })

  it('non-existent .car file', T, async () => {
    const result = await runCli(['import', 'non-existent-archive.car'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('File not found: non-existent-archive.car')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// payments
// ═══════════════════════════════════════════════════════════════════════════

describe('payments', () => {
  it('no subcommand shows usage', T, async () => {
    const result = await runCli(['payments'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('Usage: filecoin-pin payments')
  })
})

describe('payments setup', () => {
  it('no TTY — requires --auto flag in non-interactive environments', T, async () => {
    const result = await runCli(['payments', 'setup'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('Interactive mode requires a TTY terminal')
  })
})

describe('payments status', () => {
  it('no auth', T, async () => {
    const result = await runCli(['payments', 'status'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('No authentication provided')
  })
})

describe('payments fund', () => {
  it('missing required --days or --amount option', T, async () => {
    const result = await runCli(['payments', 'fund'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('Specify exactly one of --days')
  })
})

describe('payments deposit', () => {
  it('missing required --amount option', T, async () => {
    const result = await runCli(['payments', 'deposit'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain("required option '--amount <usdfc>' not specified")
  })
})

describe('payments withdraw', () => {
  it('missing required --amount option', T, async () => {
    const result = await runCli(['payments', 'withdraw'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain("required option '--amount <usdfc>' not specified")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// data-set
// ═══════════════════════════════════════════════════════════════════════════

describe('data-set', () => {
  it('no subcommand shows usage', T, async () => {
    const result = await runCli(['data-set'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('Usage: filecoin-pin data-set|dataset')
  })
})

describe('data-set show', () => {
  it('missing required dataSetId argument', T, async () => {
    const result = await runCli(['data-set', 'show'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain("missing required argument 'dataSetId'")
  })

  it('no auth', T, async () => {
    const result = await runCli(['data-set', 'show', '42'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('No authentication provided')
  })

  it('non-numeric dataSetId', T, async () => {
    const result = await runCli(['data-set', 'show', 'not-a-number'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('invalid or not a positive integer')
  })

  it('partial-match dataSetId is rejected (e.g. "12abc")', T, async () => {
    const result = await runCli(['data-set', 'show', '12abc'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('invalid or not a positive integer')
  })

  it('decimal dataSetId is rejected (e.g. "1.5")', T, async () => {
    const result = await runCli(['data-set', 'show', '1.5'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('invalid or not a positive integer')
  })

  it('invalid id does not flash "#NaN" in the command title', T, async () => {
    const result = await runCli(['data-set', 'show', 'NaN'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).not.toContain('#NaN')
    expect(result.combined).toContain('invalid or not a positive integer')
  })
})

describe('data-set list', () => {
  it('no auth', T, async () => {
    const result = await runCli(['data-set', 'list'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('No authentication provided')
  })
})

describe('data-set terminate', () => {
  it('missing required dataSetId argument', T, async () => {
    const result = await runCli(['data-set', 'terminate'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain("missing required argument 'dataSetId'")
  })

  it('no auth', T, async () => {
    const result = await runCli(['data-set', 'terminate', '42'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('No authentication provided')
  })

  it('non-numeric dataSetId is rejected', T, async () => {
    const result = await runCli(['data-set', 'terminate', '12abc'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('invalid or not a positive integer')
  })
})

describe('data-set piece-status', () => {
  it('missing required dataSetId argument', T, async () => {
    const result = await runCli(['data-set', 'piece-status'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain("missing required argument 'dataSetId'")
  })

  it('no auth', T, async () => {
    const result = await runCli(['data-set', 'piece-status', '42'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('No authentication provided')
  })

  it('non-numeric dataSetId is rejected', T, async () => {
    const result = await runCli(['data-set', 'piece-status', '12abc'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('invalid or not a positive integer')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// provider
// ═══════════════════════════════════════════════════════════════════════════

describe('provider', () => {
  it('no subcommand shows usage', T, async () => {
    const result = await runCli(['provider'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('Usage: filecoin-pin provider')
  })
})

describe('provider show', () => {
  it('missing required provider argument', T, async () => {
    const result = await runCli(['provider', 'show'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain("missing required argument 'provider'")
  })

  it('non-numeric provider id is rejected with a clear validation error', T, async () => {
    const result = await runCli(['provider', 'show', 'not-a-number'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('Provider ID must be numeric')
  })

  it('partial-match id is rejected (e.g. "12abc")', T, async () => {
    const result = await runCli(['provider', 'show', '12abc'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('Provider ID must be numeric')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// rm
// ═══════════════════════════════════════════════════════════════════════════

describe('rm', () => {
  it('no options — neither --piece nor --all supplied', T, async () => {
    const result = await runCli(['rm'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('Either --piece or --all is required')
  })

  it('--piece without required --data-set-id', T, async () => {
    const result = await runCli(['rm', '--piece', 'bafkreiabc1234567890abcdef'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('At least one --data-set-id is required')
  })

  it('--all without required --data-set-id', T, async () => {
    const result = await runCli(['rm', '--all'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('At least one --data-set-id is required')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// session
// ═══════════════════════════════════════════════════════════════════════════

describe('session', () => {
  it('no subcommand shows usage', T, async () => {
    const result = await runCli(['session'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('Usage: filecoin-pin session')
  })
})

describe('session create', () => {
  it('no auth', T, async () => {
    const result = await runCli(['session', 'create'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('PRIVATE_KEY environment variable or --private-key option is required')
  })
})

describe('session generate', () => {
  it('exits 0 and prints a keypair', T, async () => {
    const result = await runCli(['session', 'generate'])
    expect(result.exitCode).toBe(0)
    expect(result.combined).toContain('SESSION_KEY=0x')
    expect(result.combined).toContain('SESSION_ADDRESS=0x')
    expect(result.combined).toContain('Session keypair generated locally')
  })
})

describe('session authorize', () => {
  it('missing required session-address argument', T, async () => {
    const result = await runCli(['session', 'authorize'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain("missing required argument 'session-address'")
  })

  it('no auth', T, async () => {
    const result = await runCli(['session', 'authorize', '0x1234567890123456789012345678901234567890'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('PRIVATE_KEY environment variable or --private-key option is required')
  })
})

describe('session revoke', () => {
  it('missing required session-address argument', T, async () => {
    const result = await runCli(['session', 'revoke'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain("missing required argument 'session-address'")
  })

  it('no auth', T, async () => {
    const result = await runCli(['session', 'revoke', '0x1234567890123456789012345678901234567890'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toContain('PRIVATE_KEY environment variable or --private-key option is required')
  })
})
