import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * CLI Error Matrix Smoke Tests
 *
 * Validates error handling across all CLI commands without requiring live RPC.
 * Tests capture stdout, stderr, and exit codes to ensure consistent error behavior.
 *
 * Prerequisites: Run `pnpm run build` to compile dist/cli.js before running tests
 * (or use `pnpm run smoke` which auto-builds)
 *
 * Run all smoke tests: pnpm run smoke
 * Run with network tests: pnpm run smoke:network
 * Run specific test: pnpm run smoke -- -t "payments setup"
 */

interface CliResult {
  stdout: string
  stderr: string
  exitCode: number
  command: string
}

/**
 * Execute a CLI command and capture output using execFileSync for proper argument handling
 */
function runCli(args: string[], env: Record<string, string> = {}): CliResult {
  // Always add --no-update-check to prevent npm registry fetches
  const fullArgs = ['dist/cli.js', '--no-update-check', ...args]
  const command = `node ${fullArgs.join(' ')}`

  try {
    const stdout = execFileSync('node', fullArgs, {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
      env: {
        ...process.env,
        ...env,
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
 * Skip network-dependent tests unless explicitly enabled via --mode network
 */
const skipIfNoNetwork = process.env.VITEST_MODE !== 'network'

/**
 * Skip all tests if dist/cli.js doesn't exist (not built yet)
 */
const skipIfNotBuilt = !existsSync('dist/cli.js')

describe('CLI Error Matrix - Smoke Tests', { skip: skipIfNotBuilt }, () => {
  describe('payments setup', () => {
    it('should error when PRIVATE_KEY is missing with --auto flag', () => {
      const result = runCli(['payments', 'setup', '--auto'], { PRIVATE_KEY: '' })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('PRIVATE_KEY')
    })

    it('should error with invalid network option', () => {
      const result = runCli(['payments', 'setup', '--network', 'invalid'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('network')
    })

    it('should error when --network and --rpc-url are both provided', () => {
      const result = runCli([
        'payments',
        'setup',
        '--auto',
        '--network',
        'mainnet',
        '--rpc-url',
        'https://example.com',
      ])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('mutually exclusive')
    })
  })

  describe('payments fund', () => {
    it('should error when PRIVATE_KEY is missing', () => {
      const result = runCli(['payments', 'fund', '--days', '30'], { PRIVATE_KEY: '' })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('PRIVATE_KEY')
    })

    it('should error when neither --days nor --amount is provided', () => {
      const result = runCli(['payments', 'fund'], {
        PRIVATE_KEY: '0x1234567890123456789012345678901234567890123456789012345678901234',
      })

      expect(result.exitCode).not.toBe(0)
      // This will fail early on validation
    })
  })

  describe('payments deposit', () => {
    it('should error when PRIVATE_KEY is missing', () => {
      const result = runCli(['payments', 'deposit', '--amount', '10'], { PRIVATE_KEY: '' })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('PRIVATE_KEY')
    })
  })

  describe('payments withdraw', () => {
    it('should error when PRIVATE_KEY is missing', () => {
      const result = runCli(['payments', 'withdraw', '--amount', '5'], { PRIVATE_KEY: '' })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('PRIVATE_KEY')
    })

    it('should error when --amount is missing', () => {
      const result = runCli(['payments', 'withdraw'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('--amount')
    })
  })

  describe('payments status', () => {
    it('should error when PRIVATE_KEY is missing', () => {
      const result = runCli(['payments', 'status'], { PRIVATE_KEY: '' })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('PRIVATE_KEY')
    })
  })

  describe('add', () => {
    it('should error when path argument is missing', () => {
      const result = runCli(['add'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('argument')
    })

    it('should error when file does not exist', () => {
      const result = runCli(['add', '/nonexistent/path/file.txt'], {
        PRIVATE_KEY: '0x1234567890123456789012345678901234567890123456789012345678901234',
      })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatch(/not found|does not exist|ENOENT/i)
    })

    it('should error with invalid copies value', () => {
      const result = runCli(['add', 'package.json', '--copies', 'invalid'])

      expect(result.exitCode).not.toBe(0)
      // Commander will catch invalid number format
    })
  })

  describe('import', () => {
    it('should error when CAR file argument is missing', () => {
      const result = runCli(['import'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('argument')
    })

    it('should error when CAR file does not exist', () => {
      const result = runCli(['import', '/nonexistent/file.car'], {
        PRIVATE_KEY: '0x1234567890123456789012345678901234567890123456789012345678901234',
      })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatch(/not found|does not exist|ENOENT/i)
    })
  })

  describe('data-set show', () => {
    it('should error when data set ID is missing', () => {
      const result = runCli(['data-set', 'show'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('argument')
    })

    it('should error when PRIVATE_KEY is missing', () => {
      const result = runCli(['data-set', 'show', '123'], { PRIVATE_KEY: '' })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('PRIVATE_KEY')
    })

    it('should error with invalid data set ID format', () => {
      const result = runCli(['data-set', 'show', 'invalid'])

      expect(result.exitCode).not.toBe(0)
      // Will fail on validation or parsing
    })
  })

  describe('data-set list', () => {
    it('should error when PRIVATE_KEY is missing', () => {
      const result = runCli(['data-set', 'list'], { PRIVATE_KEY: '' })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('PRIVATE_KEY')
    })
  })

  describe('data-set terminate', () => {
    it('should error when data set ID is missing', () => {
      const result = runCli(['data-set', 'terminate'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('argument')
    })

    it('should error when PRIVATE_KEY is missing', () => {
      const result = runCli(['data-set', 'terminate', '123'], { PRIVATE_KEY: '' })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('PRIVATE_KEY')
    })

    it('should error with invalid data set ID format', () => {
      const result = runCli(['data-set', 'terminate', 'invalid'])

      expect(result.exitCode).not.toBe(0)
      // Will fail on validation or parsing
    })
  })

  describe('provider list', () => {
    it('should work without PRIVATE_KEY (uses public view)', () => {
      // Provider commands use ensurePublicAuth() which allows viewing without auth
      // This is not an error case, so we skip this test
    })
  })

  describe('provider show', () => {
    it('should error when provider ID is missing', () => {
      const result = runCli(['provider', 'show'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('argument')
    })
  })

  describe('provider ping', () => {
    it('should work without provider ID (pings all approved)', () => {
      // Provider ping allows optional provider ID
      // This is not an error case, so we skip this test
    })
  })

  describe('rm', () => {
    it('should error when --data-set is missing', () => {
      const result = runCli(['rm', '--piece', 'baga6ea4seaqao7s73y24kcutaosvacpdjgfe5pw76ooefnyqw4ynr3d2y6x2mpq'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('--data-set')
    })

    it('should error when neither --piece nor --all is provided', () => {
      const result = runCli(['rm', '--data-set', '123'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatch(/--piece|--all/)
    })

    it('should error when PRIVATE_KEY is missing', () => {
      const result = runCli(
        ['rm', '--data-set', '123', '--piece', 'baga6ea4seaqao7s73y24kcutaosvacpdjgfe5pw76ooefnyqw4ynr3d2y6x2mpq'],
        {
          PRIVATE_KEY: '',
        },
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('PRIVATE_KEY')
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
      expect(result.stderr).toMatch(/RPC|connection|network/i)
    })

    it('should error with invalid RPC URL format', () => {
      const result = runCli(['payments', 'status', '--rpc-url', 'not-a-url'], {
        PRIVATE_KEY: '0x1234567890123456789012345678901234567890123456789012345678901234',
      })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatch(/URL|invalid/i)
    })
  })
})
