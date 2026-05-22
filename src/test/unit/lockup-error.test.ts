import { describe, expect, it } from 'vitest'
import { describeLockupShortfall, parseInsufficientLockup } from '../../common/lockup-error.js'

// Mirrors the real CommitError chain surfaced by the SDK on a CDN upload.
const commitError = {
  name: 'CommitError',
  message:
    'Failed to commit on primary provider 4 - data is stored but not on-chain\n\nDetails: Warm Storage\nInsufficientLockupFunds(address payer, uint256 minimumRequired, uint256 available)\n                       (0x79525C4Fc20b5354aE619dC1ef1e6f4484760762, 1160000000000000000, 500159722223374120)',
  cause: {
    name: 'CreateDataSetError',
    message: 'Failed to create data set.',
  },
}

describe('parseInsufficientLockup', () => {
  it('extracts minimumRequired and available from the revert text', () => {
    expect(parseInsufficientLockup(commitError)).toEqual({
      minimumRequired: 1_160_000_000_000_000_000n,
      available: 500_159_722_223_374_120n,
    })
  })

  it('finds the revert when it lives in a nested cause', () => {
    const wrapped = { name: 'OuterError', message: 'upload failed', cause: commitError }
    expect(parseInsufficientLockup(wrapped)).toEqual({
      minimumRequired: 1_160_000_000_000_000_000n,
      available: 500_159_722_223_374_120n,
    })
  })

  it('returns null for unrelated errors', () => {
    expect(parseInsufficientLockup(new Error('network timeout'))).toBeNull()
    expect(parseInsufficientLockup(undefined)).toBeNull()
  })
})

describe('describeLockupShortfall', () => {
  it('produces a headline and the shortfall amounts, without editorializing on cause', () => {
    const result = describeLockupShortfall(commitError)
    expect(result?.headline).toContain('insufficient locked funds')
    expect(result?.hints[0]).toContain('1.16')
    expect(result?.hints[0]).toContain('0.5')
    // The generic lockup error must not assert a CDN-specific cause or remedy.
    expect(result?.hints.some((h) => h.includes('CDN') || h.includes('--egress-provider'))).toBe(false)
  })

  it('returns null for unrelated errors', () => {
    expect(describeLockupShortfall(new Error('boom'))).toBeNull()
  })
})
