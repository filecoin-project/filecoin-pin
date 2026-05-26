import { describe, expect, it } from 'vitest'
import { parseValidityDays } from '../../session/parse-validity-days.js'

describe('parseValidityDays', () => {
  it('parses a plain integer string', () => {
    expect(parseValidityDays('30')).toBe(30)
  })

  it('falls back to the default when undefined', () => {
    expect(parseValidityDays(undefined)).toBe(10)
    expect(parseValidityDays(undefined, 30)).toBe(30)
  })

  it('rejects trailing non-digits', () => {
    expect(() => parseValidityDays('10foo')).toThrow(/Invalid --validity-days/)
  })

  it('rejects negative, zero, and decimal inputs', () => {
    expect(() => parseValidityDays('-1')).toThrow(/Invalid --validity-days/)
    expect(() => parseValidityDays('0')).toThrow(/Invalid --validity-days/)
    expect(() => parseValidityDays('1.5')).toThrow(/Invalid --validity-days/)
  })
})
