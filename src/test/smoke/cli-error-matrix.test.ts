import { execSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

/**
 * CLI Error Matrix Smoke Tests
 *
 * Validates error handling across all CLI commands without requiring live RPC.
 * Tests capture stdout, stderr, and exit codes to ensure consistent error behavior.
 *
 * Run all smoke tests: pnpm run smoke
 * Run with network tests: SMOKE_NETWORK=1 pnpm run smoke
 * Update snapshots: pnpm run smoke -- -u
 */

interface CliResult {
  stdout: string
  stderr: string
  exitCode: number
  command: string
}

/**
 * Execute a CLI command and capture output
 */
function runCli(args: string[], env: Record<string, string> = {}): CliResult {
  const command = `node dist/cli.js ${args.join(' ')}`

  try {
    const stdout = execSync(command, {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
      env: {
        ...process.env,
        ...env,
        // Disable update checks for deterministic output
        NO_UPDATE_CHECK: '1',
      },
    })

    return {
      stdout,
      stderr: '',
      exitCode: 0,
      command,
    }
  } catch (error: any) {
    return {
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '',
      exitCode: error.status ?? 1,
      command,
    }
  }
}

/**
 * Skip network-dependent tests unless explicitly enabled
 */
const skipIfNoNetwork = process.env.SMOKE_NETWORK !== '1'

describe('CLI Error Matrix - Smoke Tests', () => {
  describe('payments setup', () => {
    it('should error when PRIVATE_KEY is missing', () => {
      const result = runCli(['payments', 'setup'], { PRIVATE_KEY: '' })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })

    it('should error with invalid network option', () => {
      const result = runCli(['payments', 'setup', '--network', 'invalid'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })

    it('should error when --network and --rpc-url are both provided', () => {
      const result = runCli([
        'payments',
        'setup',
        '--network',
        'mainnet',
        '--rpc-url',
        'https://example.com',
      ])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })
  })

  describe('payments fund', () => {
    it('should error when PRIVATE_KEY is missing', () => {
      const result = runCli(['payments', 'fund'], { PRIVATE_KEY: '' })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })

    it('should error with invalid amount format', () => {
      const result = runCli(['payments', 'fund', '--amount', 'invalid'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })
  })

  describe('payments deposit', () => {
    it('should error when PRIVATE_KEY is missing', () => {
      const result = runCli(['payments', 'deposit'], { PRIVATE_KEY: '' })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })

    it('should error with invalid amount format', () => {
      const result = runCli(['payments', 'deposit', '--amount', 'invalid'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })
  })

  describe('payments withdraw', () => {
    it('should error when PRIVATE_KEY is missing', () => {
      const result = runCli(['payments', 'withdraw'], { PRIVATE_KEY: '' })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })

    it('should error with invalid amount format', () => {
      const result = runCli(['payments', 'withdraw', '--amount', 'invalid'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })
  })

  describe('payments status', () => {
    it('should error when PRIVATE_KEY is missing', () => {
      const result = runCli(['payments', 'status'], { PRIVATE_KEY: '' })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })
  })

  describe('add', () => {
    it('should error when path argument is missing', () => {
      const result = runCli(['add'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })

    it('should error when PRIVATE_KEY is missing', () => {
      const result = runCli(['add', 'nonexistent.txt'], { PRIVATE_KEY: '' })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })

    it('should error when file does not exist', () => {
      const result = runCli(['add', '/nonexistent/path/file.txt'], {
        PRIVATE_KEY: '0x1234567890123456789012345678901234567890123456789012345678901234',
      })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })

    it('should error with invalid copies value', () => {
      const result = runCli(['add', 'package.json', '--copies', 'invalid'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })
  })

  describe('import', () => {
    it('should error when CAR file argument is missing', () => {
      const result = runCli(['import'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })

    it('should error when PRIVATE_KEY is missing', () => {
      const result = runCli(['import', 'file.car'], { PRIVATE_KEY: '' })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })

    it('should error when CAR file does not exist', () => {
      const result = runCli(['import', '/nonexistent/file.car'], {
        PRIVATE_KEY: '0x1234567890123456789012345678901234567890123456789012345678901234',
      })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })
  })

  describe('data-set show', () => {
    it('should error when data set ID is missing', () => {
      const result = runCli(['data-set', 'show'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })

    it('should error when PRIVATE_KEY is missing', () => {
      const result = runCli(['data-set', 'show', '123'], { PRIVATE_KEY: '' })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })

    it('should error with invalid data set ID format', () => {
      const result = runCli(['data-set', 'show', 'invalid'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })
  })

  describe('data-set list', () => {
    it('should error when PRIVATE_KEY is missing', () => {
      const result = runCli(['data-set', 'list'], { PRIVATE_KEY: '' })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })
  })

  describe('data-set terminate', () => {
    it('should error when data set ID is missing', () => {
      const result = runCli(['data-set', 'terminate'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })

    it('should error when PRIVATE_KEY is missing', () => {
      const result = runCli(['data-set', 'terminate', '123'], { PRIVATE_KEY: '' })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })

    it('should error with invalid data set ID format', () => {
      const result = runCli(['data-set', 'terminate', 'invalid'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })
  })

  describe('provider list', () => {
    it('should error when PRIVATE_KEY is missing', () => {
      const result = runCli(['provider', 'list'], { PRIVATE_KEY: '' })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })
  })

  describe('provider show', () => {
    it('should error when provider ID is missing', () => {
      const result = runCli(['provider', 'show'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })

    it('should error when PRIVATE_KEY is missing', () => {
      const result = runCli(['provider', 'show', 'f01234'], { PRIVATE_KEY: '' })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })
  })

  describe('provider ping', () => {
    it('should error when provider ID is missing', () => {
      const result = runCli(['provider', 'ping'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })

    it('should error when PRIVATE_KEY is missing', () => {
      const result = runCli(['provider', 'ping', 'f01234'], { PRIVATE_KEY: '' })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })
  })

  describe('rm', () => {
    it('should error when piece CID is missing', () => {
      const result = runCli(['rm'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })

    it('should error when PRIVATE_KEY is missing', () => {
      const result = runCli(['rm', 'baga6ea4seaqao7s73y24kcutaosvacpdjgfe5pw76ooefnyqw4ynr3d2y6x2mpq'], {
        PRIVATE_KEY: '',
      })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })
  })

  describe('Network-dependent scenarios', { skip: skipIfNoNetwork }, () => {
    it('should error with unreachable RPC endpoint', () => {
      const result = runCli(
        ['payments', 'status', '--rpc-url', 'https://invalid-rpc-endpoint-that-does-not-exist.example.com'],
        {
          PRIVATE_KEY: '0x1234567890123456789012345678901234567890123456789012345678901234',
        },
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('RPC')
    })

    it('should error with invalid RPC URL format', () => {
      const result = runCli(['payments', 'status', '--rpc-url', 'not-a-url'], {
        PRIVATE_KEY: '0x1234567890123456789012345678901234567890123456789012345678901234',
      })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatchInlineSnapshot()
    })
  })
})
