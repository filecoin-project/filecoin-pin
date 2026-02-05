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


})
