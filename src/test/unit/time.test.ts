import { describe, expect, it } from 'vitest'
import { formatRunwayDuration, formatRunwaySummary } from '../../core/utils/index.js'

describe('formatRunwayDuration', () => {
  it('formats small durations with days and hours', () => {
    expect(formatRunwayDuration(0, 5)).toBe('0 day(s) 5 hour(s)')
    expect(formatRunwayDuration(5, 12)).toBe('5 day(s) 12 hour(s)')
    expect(formatRunwayDuration(59, 0)).toBe('59 day(s)')
  })

  it('formats medium durations with months and days', () => {
    expect(formatRunwayDuration(60, 0)).toBe('2 month(s)')
    expect(formatRunwayDuration(75, 0)).toBe('2 month(s) 15 day(s)')
    expect(formatRunwayDuration(120, 0)).toBe('4 month(s)')
  })

  it('formats large durations with years, months, and days', () => {
    expect(formatRunwayDuration(365, 0)).toBe('1 year(s)')
    expect(formatRunwayDuration(400, 0)).toBe('1 year(s) 1 month(s) 5 day(s)')
    expect(formatRunwayDuration(800, 0)).toBe('2 year(s) 2 month(s) 10 day(s)')
  })
})

describe('formatRunwaySummary', () => {
  it('formats active runway using duration formatter', () => {
    const summary = {
      state: 'active',
      available: 0n,
      rateUsed: 0n,
      perDay: 0n,
      lockupUsed: 0n,
      days: 5,
      hours: 12,
    } as const
    expect(formatRunwaySummary(summary)).toBe('5 day(s) 12 hour(s)')
  })

  it('describes no-spend state', () => {
    const summary = {
      state: 'no-spend',
      available: 0n,
      rateUsed: 0n,
      perDay: 0n,
      lockupUsed: 0n,
      days: 0,
      hours: 0,
    } as const
    expect(formatRunwaySummary(summary)).toBe('No active spend detected')
  })

  it('describes unknown state', () => {
    const summary = {
      state: 'unknown',
      available: 0n,
      rateUsed: 0n,
      perDay: 0n,
      lockupUsed: 0n,
      days: 0,
      hours: 0,
    } as const
    expect(formatRunwaySummary(summary)).toBe('Unknown')
  })
})
