import { execSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('CLI entrypoint', () => {
  it('CLI entrypoint loads without throwing an error', { timeout: 15000 }, () => {
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

  it('groups commands and provides a user-facing quick start in --help', { timeout: 15000 }, () => {
    const out = execSync('node dist/cli.js --help', {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
    })

    const headings = [
      'USAGE',
      'UPLOAD',
      'PAYMENTS',
      'MANAGEMENT',
      'ADVANCED',
      'OPTIONS',
      'EXAMPLES',
      'EXIT CODES',
      'DOCUMENTATION',
    ]
    const headingPositions = headings.map((heading) => out.indexOf(heading))
    expect(headingPositions.every((position) => position >= 0)).toBe(true)
    expect(headingPositions).toEqual([...headingPositions].sort((left, right) => left - right))

    for (const heading of headings) {
      expect(out).not.toContain(`${heading}:`)
    }

    expect(out.indexOf('IPFS Pinning Service with Filecoin storage')).toBeLessThan(out.indexOf('USAGE'))
    expect(out).toContain('\nUSAGE\n  filecoin-pin [options] [command]\n')
    expect(out).toMatch(/add .*<path>/)
    expect(out).toContain('Upload a file or directory to Filecoin')
    expect(out).toMatch(/import .*<file>/)
    expect(out).toContain('Upload an existing CAR file to Filecoin')
    expect(out).toMatch(/Manage storage payments \(required before your first\s+upload\)/)
    expect(out).toContain('filecoin-pin payments setup --auto')
    expect(out).toContain('filecoin-pin add ./myfile.txt')
    expect(out).toContain('filecoin-pin import ./archive.car')
    expect(out).toContain('filecoin-pin dataset ls')
    expect(out).toContain('https://docs.filecoin.cloud/getting-started/filecoin-pin/')
    expect(out).not.toMatch(/Synapse SDK|UnixFS CAR|FWSS/)
  })

  it('add command exposes --egress-provider in --help', { timeout: 15000 }, () => {
    const out = execSync('node dist/cli.js add --help', {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    expect(out).toContain('--egress-provider')
    expect(out).toContain('beam')
    expect(out).toContain('none')
  })

  it('import command exposes --egress-provider in --help', { timeout: 15000 }, () => {
    const out = execSync('node dist/cli.js import --help', {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    expect(out).toContain('--egress-provider')
  })

  it('session revoke command is visible and exposes owner network options', { timeout: 15000 }, () => {
    const sessionHelp = execSync('node dist/cli.js session --help', {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    expect(sessionHelp).toContain('revoke')

    const revokeHelp = execSync('node dist/cli.js session revoke --help', {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    expect(revokeHelp).toContain('<session-address>')
    expect(revokeHelp).toContain('--private-key')
    expect(revokeHelp).toContain('--network')
    expect(revokeHelp).toContain('--rpc-url')
  })
})
