import { describe, expect, it } from 'vitest'
import {
  collectedCidFromError,
  DEFAULT_ASSUMED_WINDOW_MS,
  lowerWindowOnGc,
  MAX_ADD_PIECES_BATCH,
  MIN_MARGIN_MS,
  MIN_WINDOW_MS,
  marginFromConfirmations,
  shouldFlush,
} from '../../migrate/gc-window.js'

// Locks in the flush-scheduling rules: every tie breaks toward flushing
// sooner, and the window estimate only ever moves down.

const base = {
  batchSize: 1,
  oldestParkedAtMs: 0,
  nowMs: 0,
  assumedWindowMs: DEFAULT_ASSUMED_WINDOW_MS,
  marginMs: MIN_MARGIN_MS,
  drained: false,
}

describe('shouldFlush', () => {
  it('never flushes an empty batch, even drained', () => {
    expect(shouldFlush({ ...base, batchSize: 0, drained: true })).toBeNull()
  })

  it('flushes a full batch regardless of timers', () => {
    expect(shouldFlush({ ...base, batchSize: MAX_ADD_PIECES_BATCH })).toBe('batch-full')
  })

  it('includes the margin in window expiry', () => {
    const edge = DEFAULT_ASSUMED_WINDOW_MS - MIN_MARGIN_MS
    expect(shouldFlush({ ...base, nowMs: edge - 1 })).toBeNull()
    expect(shouldFlush({ ...base, nowMs: edge })).toBe('window')
  })

  it('flushes a partial batch when drained', () => {
    expect(shouldFlush({ ...base, drained: true })).toBe('drained')
  })
})

describe('marginFromConfirmations', () => {
  it('uses the floor without observations, 2x worst with', () => {
    expect(marginFromConfirmations([])).toBe(MIN_MARGIN_MS)
    expect(marginFromConfirmations([1_000, 2_000])).toBe(MIN_MARGIN_MS)
    const slow = 20 * 60_000
    expect(marginFromConfirmations([1_000, slow])).toBe(2 * slow)
  })

  it('forgets a spike once five later commits are observed', () => {
    const slow = 30 * 60_000
    expect(marginFromConfirmations([slow, 1_000, 1_000, 1_000, 1_000, 1_000])).toBe(MIN_MARGIN_MS)
  })
})

describe('lowerWindowOnGc', () => {
  it('lowers from evidence, never raises, floors', () => {
    const hourMs = 60 * 60_000
    expect(lowerWindowOnGc(hourMs, 40 * 60_000)).toBe(30 * 60_000)
    // Evidence above the current guess must not raise it.
    expect(lowerWindowOnGc(hourMs, 10 * hourMs)).toBe(hourMs)
    expect(lowerWindowOnGc(hourMs, 0)).toBe(MIN_WINDOW_MS)
  })
})

describe('collectedCidFromError', () => {
  it('parses the Curio GC rejection and nothing else', () => {
    const cid = 'bafkzcibf3ck4uais4fgennh4hbfx5z3i6hue4xgq2cdeamtus4hjbsrjs5lf2azbxmsa'
    expect(
      collectedCidFromError(
        `Failed to process request: subPiece CID ${cid} not found or does not belong to service foo`
      )
    ).toBe(cid)
    expect(collectedCidFromError('insufficient funds')).toBeNull()
  })
})

describe('window floor', () => {
  it('keeps the floor above the margin floor so a floored window still batches', () => {
    expect(MIN_WINDOW_MS).toBeGreaterThan(MIN_MARGIN_MS)
  })

  it('never raises a window the operator set below the floor', () => {
    expect(lowerWindowOnGc(60_000, 10 * 60_000)).toBe(60_000)
  })
})
