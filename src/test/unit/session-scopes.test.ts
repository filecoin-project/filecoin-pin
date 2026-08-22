import {
  AddPiecesPermission,
  CreateDataSetPermission,
  SchedulePieceRemovalsPermission,
} from '@filoz/synapse-core/session-key'
import { describe, expect, it } from 'vitest'
import { TerminateServicePermission } from '../../core/session/index.js'
import { describeScopes, parseScopes, SCOPE_IDS } from '../../session/scopes.js'

describe('parseScopes', () => {
  it('parses a single scope to its permission typehash', () => {
    const { ids, permissions } = parseScopes('addPieces')
    expect(ids).toEqual(['addPieces'])
    expect(permissions).toEqual([AddPiecesPermission])
  })

  it('returns ids in canonical order regardless of input order', () => {
    expect(parseScopes('terminateService,createDataSet').ids).toEqual(['createDataSet', 'terminateService'])
  })

  it('is case-insensitive', () => {
    expect(parseScopes('ADDPIECES,TerminateService').ids).toEqual(['addPieces', 'terminateService'])
  })

  it('dedupes repeated scopes', () => {
    expect(parseScopes('addPieces,addPieces').ids).toEqual(['addPieces'])
  })

  it('tolerates whitespace around tokens', () => {
    expect(parseScopes(' addPieces , createDataSet ').ids).toEqual(['createDataSet', 'addPieces'])
  })

  it('maps all four ids to their permission typehashes in canonical order', () => {
    expect(parseScopes('terminateService,schedulePieceRemovals,addPieces,createDataSet').permissions).toEqual([
      CreateDataSetPermission,
      AddPiecesPermission,
      SchedulePieceRemovalsPermission,
      TerminateServicePermission,
    ])
  })

  it('accepts short aliases, normalizing to canonical ids', () => {
    expect(parseScopes('add').ids).toEqual(['addPieces'])
    expect(parseScopes('create').ids).toEqual(['createDataSet'])
    expect(parseScopes('terminate').ids).toEqual(['terminateService'])
    expect(parseScopes('remove').ids).toEqual(['schedulePieceRemovals'])
    expect(parseScopes('delete').ids).toEqual(['schedulePieceRemovals'])
  })

  it('mixes aliases with canonical ids and is case-insensitive on aliases', () => {
    expect(parseScopes('ADD,createDataSet,Remove').ids).toEqual(['createDataSet', 'addPieces', 'schedulePieceRemovals'])
  })

  it('rejects an unknown scope, naming it and the valid list', () => {
    expect(() => parseScopes('addPieces,nope')).toThrow(/Unknown scope "nope"/)
    expect(() => parseScopes('nope')).toThrow(/Valid scopes:/)
  })

  it('rejects input with no valid scope', () => {
    expect(() => parseScopes('')).toThrow(/at least one/)
    expect(() => parseScopes(' , , ')).toThrow(/at least one/)
  })
})

describe('describeScopes', () => {
  it('renders undefined as the full set', () => {
    expect(describeScopes()).toBe(`all (${SCOPE_IDS.join(', ')})`)
  })

  it('joins provided ids', () => {
    expect(describeScopes(['addPieces', 'createDataSet'])).toBe('addPieces, createDataSet')
  })
})
