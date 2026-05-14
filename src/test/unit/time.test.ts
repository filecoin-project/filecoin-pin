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
  it('formats active state with both metrics', () => {
    const summary = {
      state: 'active',
      rateUsed: 0n,
      perDay: 0n,
      lockupUsed: 0n,
      runwayDays: 3,
      runwayHours: 4,
      coverageDays: 30,
      coverageHours: 0,
    } as const
    expect(formatRunwaySummary(summary)).toEqual({
      coverage: '30 day(s)',
      runway: '3 day(s) 4 hour(s)',
    })
  })

  it('describes no-spend state', () => {
    const summary = {
      state: 'no-spend',
      rateUsed: 0n,
      perDay: 0n,
      lockupUsed: 0n,
      runwayDays: 0,
      runwayHours: 0,
      coverageDays: 0,
      coverageHours: 0,
    } as const
    expect(formatRunwaySummary(summary)).toEqual({
      coverage: 'No active spend detected',
      runway: 'No active spend detected',
    })
  })
})
