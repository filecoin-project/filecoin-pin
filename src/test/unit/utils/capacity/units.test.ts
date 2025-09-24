import { describe, expect, it } from 'vitest'
import {
  getStorageUnit,
  getStorageUnitBI,
  makeStorageUnit,
  SIZE_CONSTANTS,
  SIZE_CONSTANTS_NUMBER,
} from '../../../../utils/capacity/units.js'

describe('units', () => {
  describe('getStorageUnitBI', () => {
    it('should return the correct storage unit', () => {
      expect(getStorageUnitBI(1n)).toStrictEqual({ value: 1n, unit: 'B' })
      expect(getStorageUnitBI(1024n)).toStrictEqual({ value: 1n, unit: 'KiB' })
      expect(getStorageUnitBI(1024n << 10n)).toStrictEqual({ value: 1n, unit: 'MiB' })
      expect(getStorageUnitBI(1024n << 20n)).toStrictEqual({ value: 1n, unit: 'GiB' })
      expect(getStorageUnitBI(1024n << 30n)).toStrictEqual({ value: 1n, unit: 'TiB' })
      expect(getStorageUnitBI(1024n << 40n)).toStrictEqual({ value: 1n, unit: 'PiB' })
    })
  })
  describe('getStorageUnit', () => {
    it('should return the correct whole values', () => {
      expect(getStorageUnit(1)).toStrictEqual({ value: 1n, unit: 'B' })
      expect(getStorageUnit(1024)).toStrictEqual({ value: 1n, unit: 'KiB' })
      expect(getStorageUnit(1024 << 10)).toStrictEqual({ value: 1n, unit: 'MiB' })
      expect(getStorageUnit(1024 << 20)).toStrictEqual({ value: 1n, unit: 'GiB' })
      expect(getStorageUnit(SIZE_CONSTANTS_NUMBER.TiB)).toStrictEqual({ value: 1n, unit: 'TiB' })
      expect(getStorageUnit(SIZE_CONSTANTS_NUMBER.PiB)).toStrictEqual({ value: 1n, unit: 'PiB' })
    })

    it('supports fractional values', () => {
      expect(getStorageUnit(SIZE_CONSTANTS_NUMBER.TiB * 1.5)).toStrictEqual({
        value: 1n,
        unit: 'TiB',
        remainder: { bytes: SIZE_CONSTANTS.TiB / 2n, denom: 'TiB' },
      })
      expect(getStorageUnit(SIZE_CONSTANTS_NUMBER.GiB * 1.5)).toStrictEqual({
        value: 1n,
        unit: 'GiB',
        remainder: { bytes: SIZE_CONSTANTS.GiB / 2n, denom: 'GiB' },
      })
      expect(getStorageUnit(SIZE_CONSTANTS_NUMBER.TiB * 1.5)).toStrictEqual({
        value: 1n,
        unit: 'TiB',
        remainder: { bytes: SIZE_CONSTANTS.TiB / 2n, denom: 'TiB' },
      })
      expect(getStorageUnit(SIZE_CONSTANTS_NUMBER.MiB * 1.5)).toStrictEqual({
        value: 1n,
        unit: 'MiB',
        remainder: { bytes: SIZE_CONSTANTS.MiB / 2n, denom: 'MiB' },
      })
      expect(getStorageUnit(SIZE_CONSTANTS_NUMBER.KiB * 1.5)).toStrictEqual({
        value: 1n,
        unit: 'KiB',
        remainder: { bytes: SIZE_CONSTANTS.KiB / 2n, denom: 'KiB' },
      })
      // NOTE: We cannot represent half a byte and shouldn't care, so we just return the whole value
      expect(getStorageUnit(SIZE_CONSTANTS_NUMBER.B * 1.5)).toStrictEqual({ value: 1n, unit: 'B' })
      expect(getStorageUnit(SIZE_CONSTANTS_NUMBER.B * 1.9)).toStrictEqual({ value: 2n, unit: 'B' })
      expect(getStorageUnit(SIZE_CONSTANTS_NUMBER.B * 1.1)).toStrictEqual({ value: 1n, unit: 'B' })
    })
  })
  describe('makeStorageUnit', () => {
    it('should return the correct storage unit', () => {
      expect(makeStorageUnit(1, 'B')).toStrictEqual({ value: 1n, unit: 'B' })
      expect(makeStorageUnit(1, 'KiB')).toStrictEqual({ value: 1n, unit: 'KiB' })
      expect(makeStorageUnit(1, 'MiB')).toStrictEqual({ value: 1n, unit: 'MiB' })
      expect(makeStorageUnit(1, 'GiB')).toStrictEqual({ value: 1n, unit: 'GiB' })
      expect(makeStorageUnit(1, 'TiB')).toStrictEqual({ value: 1n, unit: 'TiB' })
      expect(makeStorageUnit(1, 'PiB')).toStrictEqual({ value: 1n, unit: 'PiB' })
    })

    it('should return the correct storage unit with remainder', () => {
      expect(makeStorageUnit(1.5, 'TiB')).toStrictEqual({
        value: 1n,
        unit: 'TiB',
        remainder: { bytes: SIZE_CONSTANTS.TiB / 2n, denom: 'TiB' },
      })
      expect(makeStorageUnit(1.5, 'GiB')).toStrictEqual({
        value: 1n,
        unit: 'GiB',
        remainder: { bytes: SIZE_CONSTANTS.GiB / 2n, denom: 'GiB' },
      })
      expect(makeStorageUnit(1.5, 'MiB')).toStrictEqual({
        value: 1n,
        unit: 'MiB',
        remainder: { bytes: SIZE_CONSTANTS.MiB / 2n, denom: 'MiB' },
      })
      expect(makeStorageUnit(1.5, 'KiB')).toStrictEqual({
        value: 1n,
        unit: 'KiB',
        remainder: { bytes: SIZE_CONSTANTS.KiB / 2n, denom: 'KiB' },
      })
      expect(makeStorageUnit(1.5, 'B')).toStrictEqual({ value: 1n, unit: 'B' })
      expect(makeStorageUnit(1.9, 'B')).toStrictEqual({ value: 2n, unit: 'B' })
      expect(makeStorageUnit(1.1, 'B')).toStrictEqual({ value: 1n, unit: 'B' })
    })
  })
})
