import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveDevnetConfig } from '../../common/devnet-config.browser.js'

/**
 * Devnet config reads devnet-info.json via node:fs/os/path, so it must be kept out
 * of browser bundles. Bundlers swap ./common/devnet-config.js for its browser stub
 * via the "browser" field in package.json; resolveChainFromRpc's guarded lazy import
 * catches the stub's throw. These tests lock that wiring in place so it can't silently
 * regress and force consumers back to shipping their own stub.
 */
describe('devnet-config browser stub', () => {
  it('is wired up in the package.json "browser" field', () => {
    const pkgUrl = new URL('../../../package.json', import.meta.url)
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8'))
    expect(pkg.browser['./dist/common/devnet-config.js']).toBe('./dist/common/devnet-config.browser.js')
  })

  it('throws so the resolveChainFromRpc devnet probe falls through', () => {
    expect(() => resolveDevnetConfig()).toThrow(/not available in the browser/)
  })
})
