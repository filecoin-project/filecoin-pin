import { describe, expect, it } from 'vitest'
import { normalizeMetadataConfig, PIECE_METADATA_NAME_KEY, withDerivedNameMetadata } from '../../core/metadata/index.js'

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

describe('withDerivedNameMetadata', () => {
  it('attaches the derived name when the key is absent', () => {
    const result = withDerivedNameMetadata(undefined, 'doc.txt')
    expect(result).toEqual({ [PIECE_METADATA_NAME_KEY]: 'doc.txt' })
  })

  it('attaches the derived name alongside existing unrelated entries', () => {
    const result = withDerivedNameMetadata({ region: 'us-west' }, 'doc.txt')
    expect(result).toEqual({ region: 'us-west', [PIECE_METADATA_NAME_KEY]: 'doc.txt' })
  })

  it('preserves a user-supplied non-empty name over the derived basename', () => {
    const result = withDerivedNameMetadata({ [PIECE_METADATA_NAME_KEY]: 'custom.txt' }, 'doc.txt')
    expect(result).toEqual({ [PIECE_METADATA_NAME_KEY]: 'custom.txt' })
  })

  it('preserves a user-supplied empty string as an explicit opt-out', () => {
    // Empty string here is intentional: the user signalled "don't attach
    // a name." withDerivedNameMetadata must not overwrite it with the
    // auto-derived basename.
    const result = withDerivedNameMetadata({ [PIECE_METADATA_NAME_KEY]: '' }, 'doc.txt')
    expect(result).toEqual({ [PIECE_METADATA_NAME_KEY]: '' })
  })

  it('returns the input unchanged when the derived name itself is empty', () => {
    expect(withDerivedNameMetadata(undefined, '')).toBeUndefined()
    expect(withDerivedNameMetadata({ region: 'us-west' }, '')).toEqual({ region: 'us-west' })
  })

  it('returns the input unchanged when the derived name is null', () => {
    expect(withDerivedNameMetadata(undefined, null)).toBeUndefined()
    expect(withDerivedNameMetadata({ region: 'us-west' }, null)).toEqual({ region: 'us-west' })
  })
})
