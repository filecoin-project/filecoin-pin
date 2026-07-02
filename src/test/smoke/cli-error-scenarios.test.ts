/**
 * CLI error-scenario smoke test matrix
 * ─────────────────────────────────────
 * Issue: https://github.com/filecoin-project/filecoin-pin/issues/470
 *
 * Every test here exercises an error path that does NOT require a live RPC
 * connection (two-layer error model):
 *
 *   Layer 1 — Commander.js: missing required args, unknown flags.
 *             Exits synchronously before any app code runs.
 *
 *   Layer 2 — Command wiring (src/commands/<cmd>.ts): auth failures,
 *             argument-value validation. Runner throws → command wiring
 *             catches, prints to stderr/stdout, exits 1.
 *
 * Scope: this PR is the CI-safe, no-network, no-auth subset only.
 * Network-dependent scenarios (e.g. listing real providers, checking real
 * balances) are intentionally out of scope here — they need a funded test
 * wallet and a live calibration RPC, which is a separate PR with its own
 * gating mechanism.
 *
 * Adding a new scenario
 * ──────────────────────
 * 1. Find or create the describe() block for the command.
 * 2. Add an it() with a label that names the exact failure mode.
 * 3. Call runCli([...args]) and assert exitCode + combined snapshot.
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
    expect(result.combined).toMatchInlineSnapshot(`
      "error: too many arguments. Expected 0 arguments but got 1.
      "
    `)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// add
// ═══════════════════════════════════════════════════════════════════════════

describe('add', () => {
  it('missing required path argument', T, async () => {
    const result = await runCli(['add'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "error: missing required argument 'path'
      "
    `)
  })

  it('non-existent file path', T, async () => {
    const result = await runCli(['add', 'non-existent-file.txt'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "[1mFilecoin Pin Add[22m

      [31m✗[39m Path not found: non-existent-file.txt

      [31m✗[39m Add failed: Path not found: non-existent-file.txt

      Add cancelled
      Add failed
      "
    `)
  })

  it('no auth — valid path, PRIVATE_KEY absent', T, async () => {
    const result = await runCli(['add', 'package.json'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "[1mFilecoin Pin Add[22m

      [32m✓[39m File validated (5.2 KiB)

      [31m✗[39m Add failed: No authentication provided. Supply a private key (--private-key / PRIVATE_KEY), wallet address (--wallet-address / WALLET_ADDRESS), or session key (--session-key / SESSION_KEY).

      Add failed
      "
    `)
  })

  it('unknown flag', T, async () => {
    const result = await runCli(['add', 'file.txt', '--totally-unknown'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "error: unknown option '--totally-unknown'
      "
    `)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// import
// ═══════════════════════════════════════════════════════════════════════════

describe('import', () => {
  it('missing required file argument', T, async () => {
    const result = await runCli(['import'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "error: missing required argument 'file'
      "
    `)
  })

  it('non-existent .car file', T, async () => {
    const result = await runCli(['import', 'non-existent-archive.car'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "[1mFilecoin Pin CAR Import[22m

      [31m✗[39m File not found: non-existent-archive.car

      [31m✗[39m Import failed: File not found: non-existent-archive.car

      Import cancelled
      Import failed
      "
    `)
  })

  it('unknown flag', T, async () => {
    const result = await runCli(['import', 'archive.car', '--bad-flag'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "error: unknown option '--bad-flag'
      "
    `)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// payments
// ═══════════════════════════════════════════════════════════════════════════

describe('payments', () => {
  it('no subcommand shows usage', T, async () => {
    const result = await runCli(['payments'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "Usage: filecoin-pin payments [options] [command]

      Manage storage payments (required before your first upload)

      Options:
        -h, --help          display help for command

      Commands:
        setup [options]     Setup payment approvals for Filecoin Onchain Cloud storage
        fund [options]      Set deposited funds to an exact runway (days) or total
                            amount; deposits or withdraws to match
        withdraw [options]  Withdraw funds from Filecoin Pay to your wallet
        status [options]    Check current payment setup status
        deposit [options]   Deposit a USDFC amount into Filecoin Pay (one-way; never
                            withdraws)
        help [command]      display help for command
      "
    `)
  })
})

describe('payments setup', () => {
  // payments setup is interactive — without a TTY it errors before auth.
  it('no TTY — requires --auto flag in non-interactive environments', T, async () => {
    const result = await runCli(['payments', 'setup'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "[31mError: Interactive mode requires a TTY terminal.[39m
      Use --auto flag for non-interactive setup.
      "
    `)
  })

  it('unknown flag', T, async () => {
    const result = await runCli(['payments', 'setup', '--bogus-flag'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "error: unknown option '--bogus-flag'
      "
    `)
  })
})

describe('payments status', () => {
  it('no auth', T, async () => {
    const result = await runCli(['payments', 'status'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "[1mFilecoin Onchain Cloud Payment Status[22m

      [31m✗[39m Status check failed


      [31mError:[39m No authentication provided. Supply a private key (--private-key / PRIVATE_KEY), wallet address (--wallet-address / WALLET_ADDRESS), or session key (--session-key / SESSION_KEY).
      Status check failed
      "
    `)
  })

  it('unknown flag', T, async () => {
    const result = await runCli(['payments', 'status', '--nope'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "error: unknown option '--nope'
      "
    `)
  })
})

describe('payments fund', () => {
  // payments fund requires --days or --amount — that check fires before auth.
  it('missing required --days or --amount option', T, async () => {
    const result = await runCli(['payments', 'fund'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "[1mFilecoin Onchain Cloud Fund Adjustment[22m

      [31mError: Specify exactly one of --days <N> or --amount <USDFC>[39m
      "
    `)
  })

  it('unknown flag', T, async () => {
    const result = await runCli(['payments', 'fund', '--bad-flag'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "error: unknown option '--bad-flag'
      "
    `)
  })
})

describe('payments deposit', () => {
  // payments deposit requires --amount — Commander fires before auth.
  it('missing required --amount option', T, async () => {
    const result = await runCli(['payments', 'deposit'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "error: required option '--amount <usdfc>' not specified
      "
    `)
  })

  it('unknown flag', T, async () => {
    const result = await runCli(['payments', 'deposit', '--amount', '10', '--bad-flag'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "error: unknown option '--bad-flag'
      "
    `)
  })
})

describe('payments withdraw', () => {
  // payments withdraw requires --amount — Commander fires before auth.
  it('missing required --amount option', T, async () => {
    const result = await runCli(['payments', 'withdraw'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "error: required option '--amount <usdfc>' not specified
      "
    `)
  })

  it('unknown flag', T, async () => {
    const result = await runCli(['payments', 'withdraw', '--amount', '10', '--bad-flag'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "error: unknown option '--bad-flag'
      "
    `)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// data-set
// ═══════════════════════════════════════════════════════════════════════════

describe('data-set', () => {
  it('no subcommand shows usage', T, async () => {
    const result = await runCli(['data-set'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "Usage: filecoin-pin data-set|dataset [options] [command]

      Inspect data sets managed through Filecoin Onchain Cloud

      Options:
        -h, --help                                     display help for command

      Commands:
        show [options] <dataSetId>                     Display detailed information about a data set
        list|ls [options]                              List all data sets for the configured account
        terminate [options] <dataSetId>                Terminate a data set and associated payment rails
        piece-status [options] <dataSetId> [pieceCid]  Show the reconciled status of a data set's pieces
        help [command]                                 display help for command
      "
    `)
  })
})

describe('data-set show', () => {
  it('missing required dataSetId argument', T, async () => {
    const result = await runCli(['data-set', 'show'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "error: missing required argument 'dataSetId'
      "
    `)
  })

  it('no auth', T, async () => {
    const result = await runCli(['data-set', 'show', '42'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "[1mFilecoin Onchain Cloud Data Set Details for #42[22m

      [31m✗[39m Failed to inspect data set


      [31mError:[39m No authentication provided. Supply a private key (--private-key / PRIVATE_KEY), wallet address (--wallet-address / WALLET_ADDRESS), or session key (--session-key / SESSION_KEY).
      Inspection failed
      "
    `)
  })

  it('non-numeric dataSetId', T, async () => {
    const result = await runCli(['data-set', 'show', 'not-a-number'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "[1mFilecoin Onchain Cloud Data Set Details[22m


      [31mError:[39m Provided data set ID is invalid or not a positive integer
      Inspection failed
      "
    `)
  })

  it('partial-match dataSetId is rejected (e.g. "12abc")', T, async () => {
    const result = await runCli(['data-set', 'show', '12abc'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "[1mFilecoin Onchain Cloud Data Set Details[22m


      [31mError:[39m Provided data set ID is invalid or not a positive integer
      Inspection failed
      "
    `)
  })

  it('decimal dataSetId is rejected (e.g. "1.5")', T, async () => {
    const result = await runCli(['data-set', 'show', '1.5'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "[1mFilecoin Onchain Cloud Data Set Details[22m


      [31mError:[39m Provided data set ID is invalid or not a positive integer
      Inspection failed
      "
    `)
  })

  it('invalid id does not flash "#NaN" in the command title', T, async () => {
    const result = await runCli(['data-set', 'show', 'NaN'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).not.toContain('#NaN')
    expect(result.combined).toMatchInlineSnapshot(`
      "[1mFilecoin Onchain Cloud Data Set Details[22m


      [31mError:[39m Provided data set ID is invalid or not a positive integer
      Inspection failed
      "
    `)
  })
})

describe('data-set list', () => {
  it('no auth', T, async () => {
    const result = await runCli(['data-set', 'list'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "[1mFilecoin Onchain Cloud Data Sets[22m

      [31m✗[39m Failed to list data sets


      [31mError:[39m No authentication provided. Supply a private key (--private-key / PRIVATE_KEY), wallet address (--wallet-address / WALLET_ADDRESS), or session key (--session-key / SESSION_KEY).
      Listing failed
      "
    `)
  })

  it('unknown flag', T, async () => {
    const result = await runCli(['data-set', 'list', '--what'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "error: unknown option '--what'
      "
    `)
  })
})

describe('data-set terminate', () => {
  it('missing required dataSetId argument', T, async () => {
    const result = await runCli(['data-set', 'terminate'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "error: missing required argument 'dataSetId'
      "
    `)
  })

  it('no auth', T, async () => {
    const result = await runCli(['data-set', 'terminate', '42'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "[1mTerminate Filecoin Onchain Cloud Data Set #42[22m

      [31m✗[39m Failed to terminate data set


      [31mError:[39m No authentication provided. Supply a private key (--private-key / PRIVATE_KEY), wallet address (--wallet-address / WALLET_ADDRESS), or session key (--session-key / SESSION_KEY).
      Termination failed
      "
    `)
  })

  it('non-numeric dataSetId is rejected', T, async () => {
    const result = await runCli(['data-set', 'terminate', '12abc'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "[1mTerminate Filecoin Onchain Cloud Data Set[22m


      [31mError:[39m Provided data set ID is invalid or not a positive integer
      Termination failed
      "
    `)
  })
})

describe('data-set piece-status', () => {
  it('missing required dataSetId argument', T, async () => {
    const result = await runCli(['data-set', 'piece-status'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "error: missing required argument 'dataSetId'
      "
    `)
  })

  it('no auth', T, async () => {
    const result = await runCli(['data-set', 'piece-status', '42'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "[1mFilecoin Onchain Cloud Piece Status for Data Set #42[22m

      [31m✗[39m Failed to look up piece status


      [31mError:[39m No authentication provided. Supply a private key (--private-key / PRIVATE_KEY), wallet address (--wallet-address / WALLET_ADDRESS), or session key (--session-key / SESSION_KEY).
      Piece status lookup failed
      "
    `)
  })

  it('non-numeric dataSetId is rejected', T, async () => {
    const result = await runCli(['data-set', 'piece-status', '12abc'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "[1mFilecoin Onchain Cloud Piece Status[22m


      [31mError:[39m Provided data set ID is invalid or not a positive integer
      Piece status lookup failed
      "
    `)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// provider
// ═══════════════════════════════════════════════════════════════════════════

describe('provider', () => {
  it('no subcommand shows usage', T, async () => {
    const result = await runCli(['provider'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "Usage: filecoin-pin provider [options] [command]

      List and inspect storage providers

      Options:
        -h, --help                 display help for command

      Commands:
        list|ls [options]          List providers
        show [options] <provider>  Show details for a specific provider
        ping [options] [provider]  Ping provider PDP service. Pings all approved
                                   providers if no ID specified.
        help [command]             display help for command
      "
    `)
  })
})

describe('provider list', () => {
  it('unknown flag', T, async () => {
    const result = await runCli(['provider', 'list', '--garbage'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "error: unknown option '--garbage'
      "
    `)
  })
})

describe('provider show', () => {
  it('missing required provider argument', T, async () => {
    const result = await runCli(['provider', 'show'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "error: missing required argument 'provider'
      "
    `)
  })

  it('unknown flag', T, async () => {
    const result = await runCli(['provider', 'show', '--bogus'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "error: unknown option '--bogus'
      "
    `)
  })

  it('non-numeric provider id is rejected with a clear validation error', T, async () => {
    const result = await runCli(['provider', 'show', 'not-a-number'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "[1mProvider Details: not-a-number[22m

      [31m✗[39m Provider ID must be numeric (got: not-a-number)


      [90mQuerying providers by address is not currently supported.[39m
      Inspection failed
      "
    `)
  })

  it('partial-match id is rejected (e.g. "12abc")', T, async () => {
    const result = await runCli(['provider', 'show', '12abc'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "[1mProvider Details: 12abc[22m

      [31m✗[39m Provider ID must be numeric (got: 12abc)


      [90mQuerying providers by address is not currently supported.[39m
      Inspection failed
      "
    `)
  })
})

describe('provider ping', () => {
  it('unknown flag', T, async () => {
    const result = await runCli(['provider', 'ping', '--bogus'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "error: unknown option '--bogus'
      "
    `)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// rm
// ═══════════════════════════════════════════════════════════════════════════

describe('rm', () => {
  it('no options — neither --piece nor --all supplied', T, async () => {
    const result = await runCli(['rm'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "[31mError: Either --piece or --all is required[39m
      "
    `)
  })

  // rm also requires --data-set-id — that validation fires before auth.
  it('--piece without required --data-set-id', T, async () => {
    const result = await runCli(['rm', '--piece', 'bafkreiabc1234567890abcdef'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "[31mError: At least one --data-set-id is required[39m
      "
    `)
  })

  it('--all without required --data-set-id', T, async () => {
    const result = await runCli(['rm', '--all'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "[31mError: At least one --data-set-id is required[39m
      "
    `)
  })

  it('unknown flag', T, async () => {
    const result = await runCli(['rm', '--garbage'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "error: unknown option '--garbage'
      "
    `)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// session
// ═══════════════════════════════════════════════════════════════════════════

describe('session', () => {
  it('no subcommand shows usage', T, async () => {
    const result = await runCli(['session'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "Usage: filecoin-pin session [options] [command]

      Manage session keys for delegated upload access

      Options:
        -h, --help                             display help for command

      Commands:
        create [options]                       Generate (or reuse) a session key and authorize it on-chain
        authorize [options] <session-address>  Authorize an externally generated session address on-chain (two-party flow)
        revoke [options] <session-address>     Revoke Filecoin Pin permissions for an authorized session address
        generate                               Generate a session keypair locally (no chain interaction; consumer side of the two-party flow)
        help [command]                         display help for command
      "
    `)
  })
})

describe('session create', () => {
  it('no auth', T, async () => {
    const result = await runCli(['session', 'create'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "[1mFilecoin Pin Session Create[22m

      PRIVATE_KEY environment variable or --private-key option is required
      "
    `)
  })

  it('unknown flag', T, async () => {
    const result = await runCli(['session', 'create', '--bogus'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "error: unknown option '--bogus'
      "
    `)
  })
})

describe('session generate', () => {
  // session generate creates a random keypair locally — no snapshot since
  // the output is non-deterministic. Assert structure instead.
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
    expect(result.combined).toMatchInlineSnapshot(`
      "error: missing required argument 'session-address'
      "
    `)
  })

  it('no auth', T, async () => {
    const result = await runCli(['session', 'authorize', '0x1234567890123456789012345678901234567890'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "[1mFilecoin Pin Session Authorize[22m

      PRIVATE_KEY environment variable or --private-key option is required
      "
    `)
  })
})

describe('session revoke', () => {
  it('missing required session-address argument', T, async () => {
    const result = await runCli(['session', 'revoke'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "error: missing required argument 'session-address'
      "
    `)
  })

  it('no auth', T, async () => {
    const result = await runCli(['session', 'revoke', '0x1234567890123456789012345678901234567890'])
    expect(result.exitCode).toBe(1)
    expect(result.combined).toMatchInlineSnapshot(`
      "[1mFilecoin Pin Session Revoke[22m

      PRIVATE_KEY environment variable or --private-key option is required
      "
    `)
  })
})