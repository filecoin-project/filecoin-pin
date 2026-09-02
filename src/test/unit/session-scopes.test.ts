import {
  AddPiecesPermission,
  CreateDataSetPermission,
  SchedulePieceRemovalsPermission,
} from '@filoz/synapse-core/session-key'
import { describe, expect, it } from 'vitest'
import { TerminateServicePermission } from '../../core/session/index.js'
import { parseScopes } from '../../session/scopes.js'

describe('parseScopes', () => {
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

  it('rejects the former short aliases', () => {
    expect(() => parseScopes('add')).toThrow(/Unknown scope "add"/)
    expect(() => parseScopes('createDataSet,remove')).toThrow(/Unknown scope "remove"/)
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
