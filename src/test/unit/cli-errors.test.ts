import { describe, expect, it } from 'vitest'
import { CliFatal, isCliFatal } from '../../common/cli-errors.js'

describe('CliFatal', () => {
  it('is an Error subclass with name "CliFatal"', () => {
    const err = new CliFatal('boom')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(CliFatal)
    expect(err.name).toBe('CliFatal')
    expect(err.message).toBe('boom')
  })

  it('preserves the cause via ErrorOptions', () => {
    const cause = new Error('underlying')
    const err = new CliFatal('wrapper', { cause })
    expect(err.cause).toBe(cause)
  })
})

describe('isCliFatal', () => {
  it('identifies CliFatal instances', () => {
    expect(isCliFatal(new CliFatal('x'))).toBe(true)
  })

  it('rejects plain Error instances', () => {
    expect(isCliFatal(new Error('plain'))).toBe(false)
    expect(isCliFatal(new TypeError('typed'))).toBe(false)
  })

  it('rejects non-error values', () => {
    expect(isCliFatal(null)).toBe(false)
    expect(isCliFatal(undefined)).toBe(false)
    expect(isCliFatal('string error')).toBe(false)
    expect(isCliFatal({ message: 'fake' })).toBe(false)
  })
})

describe('outer-catch contract', () => {
  // Reference shape: runners' outer catch should skip generic display when
  // an inner branch already displayed the error and threw CliFatal.
  function simulatedOuterCatch(error: unknown, displaySpy: (msg: string) => void): void {
    if (!isCliFatal(error)) {
      const msg = error instanceof Error ? error.message : String(error)
      displaySpy(`✗ Operation failed: ${msg}`)
    }
  }

  it('does NOT display when inner branch threw CliFatal', () => {
    const calls: string[] = []
    simulatedOuterCatch(new CliFatal('already shown'), (m) => calls.push(m))
    expect(calls).toEqual([])
  })

  it('DOES display when inner branch threw plain Error', () => {
    const calls: string[] = []
    simulatedOuterCatch(new Error('rpc died'), (m) => calls.push(m))
    expect(calls).toEqual(['✗ Operation failed: rpc died'])
  })

  it('displays for non-Error throws', () => {
    const calls: string[] = []
    simulatedOuterCatch('string-throw', (m) => calls.push(m))
    expect(calls).toEqual(['✗ Operation failed: string-throw'])
  })
})
