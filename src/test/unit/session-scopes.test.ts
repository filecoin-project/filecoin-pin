import {
  AddPiecesPermission,
  CreateDataSetPermission,
  PermissionNames,
  SchedulePieceRemovalsPermission,
} from '@filoz/synapse-core/session-key'
import { describe, expect, it } from 'vitest'
import { TerminateServicePermission } from '../../core/session/index.js'
import { parseScopes, SCOPE_PERMISSIONS } from '../../session/scopes.js'

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

  it('rejects an unknown scope, naming it and the valid list', () => {
    expect(() => parseScopes('addPieces,nope')).toThrow(/Unknown scope "nope"/)
    expect(() => parseScopes('nope')).toThrow(/Valid scopes:/)
  })

  it('rejects input with no valid scope', () => {
    expect(() => parseScopes('')).toThrow(/at least one/)
    expect(() => parseScopes(' , , ')).toThrow(/at least one/)
  })
})

describe('scope-id derivation lockstep', () => {
  // core/synapse/index.ts derives scope ids by camelCasing the SDK's
  // PermissionNames instead of importing this CLI-layer map into core.
  // That derivation is only safe while PascalCase->camelCase reproduces
  // SCOPE_PERMISSIONS exactly — this cross-check makes a future rename
  // fail loudly instead of silently diverging.
  it('camelCased PermissionNames reproduce every canonical scope id', () => {
    for (const [id, permission] of Object.entries(SCOPE_PERMISSIONS)) {
      const name = PermissionNames[permission]
      if (name == null) throw new Error(`PermissionNames missing entry for scope "${id}"`)
      expect(name.charAt(0).toLowerCase() + name.slice(1)).toBe(id)
    }
  })
})
