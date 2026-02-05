import { execSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('ESM import compatibility', () => {
  it('CLI entrypoint loads without ESM import errors', { timeout: 15000 }, () => {
    // This test catches ESM compatibility issues like:
    // - Default imports on packages that only have named exports
    // - Missing exports in ESM modules
    // - Incorrect import syntax for ESM-only packages
    //
    // Example error this catches:
    // SyntaxError: The requested module '@sentry/node' does not provide
    // an export named 'default'
    expect(() => {
      execSync('node dist/cli.js --help', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        stdio: 'pipe',
      })
    }).not.toThrow()
  })

  it('instrument.ts uses namespace import for @sentry/node (not default import)', async () => {
    // Dynamically import instrument to see if it loads correctly
    // If it uses 'import Sentry from @sentry/node' (default import),
    // it will fail with: SyntaxError: The requested module '@sentry/node'
    // does not provide an export named 'default'
    await expect(import('../../instrument.js')).resolves.toBeDefined()
  })

  it('@sentry/node does not export a default export', async () => {
    // This test explicitly verifies that @sentry/node only has named exports
    // If someone tries to use default import, this test serves as documentation
    // showing why it won't work
    const sentryModule = await import('@sentry/node')
    expect(sentryModule.default).toBeUndefined()
    expect(sentryModule.init).toBeDefined()
    expect(sentryModule.setTags).toBeDefined()
  })
})
