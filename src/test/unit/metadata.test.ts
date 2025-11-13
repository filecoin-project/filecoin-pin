import { describe, expect, it } from 'vitest'
import { normalizeMetadataConfig } from '../../core/metadata/index.js'

describe('normalizeMetadataConfig', () => {
  it('returns undefined metadata when nothing provided', () => {
    const result = normalizeMetadataConfig({})
    expect(result.pieceMetadata).toBeUndefined()
    expect(result.dataSetMetadata).toBeUndefined()
  })

  it('sanitizes metadata entries and trims keys', () => {
    const result = normalizeMetadataConfig({
      pieceMetadata: {
        ' key ': 'value',
      },
      dataSetMetadata: {
        note: 'demo',
      },
    })

    expect(result.pieceMetadata).toEqual({ key: 'value' })
    expect(result.dataSetMetadata).toEqual({ note: 'demo' })
  })

  it('applies ERC-8004 sugar to metadata and dataset metadata', () => {
    const result = normalizeMetadataConfig({
      pieceMetadata: {
        custom: '1',
      },
      erc8004Type: 'registration',
      erc8004Agent: 'did:key:z123',
    })

    expect(result.pieceMetadata).toEqual({
      custom: '1',
      '8004registration': 'did:key:z123',
    })
    expect(result.dataSetMetadata).toEqual({
      erc8004Files: '',
    })
  })

  it('throws when ERC-8004 arguments are incomplete', () => {
    expect(() =>
      normalizeMetadataConfig({
        erc8004Type: 'registration',
      })
    ).toThrow(/erc8004/i)
  })

  it('throws when metadata values are not strings', () => {
    expect(() =>
      normalizeMetadataConfig({
        pieceMetadata: {
          example: 123 as unknown as string,
        },
      })
    ).toThrow(/string/)
  })
})
