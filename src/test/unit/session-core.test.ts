import { describe, expect, it } from 'vitest'
import { generateSessionKeypair } from '../../core/session/index.js'

describe('generateSessionKeypair', () => {
  it('returns a fresh 0x-prefixed private key and matching checksummed address', () => {
    const { privateKey, address } = generateSessionKeypair()
    expect(privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/)
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    // viem returns checksummed addresses
    expect(address).not.toBe(address.toLowerCase())
  })

  it('produces unique keypairs on each call', () => {
    const a = generateSessionKeypair()
    const b = generateSessionKeypair()
    expect(a.privateKey).not.toBe(b.privateKey)
    expect(a.address).not.toBe(b.address)
  })
})
