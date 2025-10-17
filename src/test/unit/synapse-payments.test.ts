import { describe, expect, it } from 'vitest'
import { getStorageScale, STORAGE_SCALE_MAX } from '../../core/payments/index.js'

describe('getStorageScale', () => {
  it('returns 1 for extremely large TiB', () => {
    const storageTiB = Number.MAX_SAFE_INTEGER // ensures floor(MAX_SAFE / storageTiB) === 0
    expect(getStorageScale(storageTiB)).toBe(1)
  })

  it('returns STORAGE_SCALE_MAX for tiny TiB', () => {
    const storageTiB = 1 / (STORAGE_SCALE_MAX * 10)
    expect(getStorageScale(storageTiB)).toBe(STORAGE_SCALE_MAX)
  })

  it('returns 1 for zero and negative inputs', () => {
    expect(getStorageScale(0)).toBe(1)
    expect(getStorageScale(-123.45)).toBe(1)
  })

  it('returns a limited scale when constrained by MAX_SAFE', () => {
    const expectedScale = 12_345
    const storageTiB = Number.MAX_SAFE_INTEGER / expectedScale

    expect(getStorageScale(storageTiB)).toBe(expectedScale)
  })

  it('returns STORAGE_SCALE_MAX exactly at the threshold boundary', () => {
    const storageTiB = Number.MAX_SAFE_INTEGER / STORAGE_SCALE_MAX
    expect(getStorageScale(storageTiB)).toBe(STORAGE_SCALE_MAX)
  })
})
