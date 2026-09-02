/**
 * Session-key scopes: the four Filecoin Pin storage permissions by their
 * camelCase ids (CreateDataSet -> createDataSet). The ids appear in
 * `--scopes` values, console links, and gating messages, so the map lives
 * in core where every consumer can share it.
 */

import {
  AddPiecesPermission,
  CreateDataSetPermission,
  type Permission,
  SchedulePieceRemovalsPermission,
} from '@filoz/synapse-core/session-key'
import { TerminateServicePermission } from './authorize-session.js'

/**
 * Scope id -> permission typehash. Key order is canonical: it drives the
 * order of parsed permissions and the display/help listing.
 */
export const SCOPE_PERMISSIONS = {
  createDataSet: CreateDataSetPermission,
  addPieces: AddPiecesPermission,
  schedulePieceRemovals: SchedulePieceRemovalsPermission,
  terminateService: TerminateServicePermission,
} as const satisfies Record<string, Permission>

/** A canonical scope id. */
export type ScopeId = keyof typeof SCOPE_PERMISSIONS

/** Canonical scope ids, in display order. */
export const SCOPE_IDS = Object.keys(SCOPE_PERMISSIONS) as ScopeId[]

const SCOPE_ID_BY_LOWERCASE: Record<string, ScopeId> = Object.fromEntries(SCOPE_IDS.map((id) => [id.toLowerCase(), id]))

/** Scope id for a permission typehash; falls back to the hash for an unknown permission. */
export function scopeIdOf(permission: Permission): ScopeId | Permission {
  return SCOPE_IDS.find((id) => SCOPE_PERMISSIONS[id] === permission) ?? permission
}

export interface ParsedScopes {
  /** Canonical scope ids that were selected, in {@link SCOPE_IDS} order. */
  ids: ScopeId[]
  /** The permission typehashes for {@link ParsedScopes.ids}. */
  permissions: Permission[]
}

/**
 * Parse a comma-separated `--scopes` value. Case-insensitive; duplicates
 * collapse; the result is ordered by {@link SCOPE_IDS} regardless of input
 * order.
 *
 * @throws if the value names an unknown scope or contains no scope at all.
 */
export function parseScopes(value: string): ParsedScopes {
  const tokens = value
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
  if (tokens.length === 0) {
    throw new Error(`--scopes needs at least one of: ${SCOPE_IDS.join(', ')}`)
  }

  const selected = new Set<ScopeId>()
  for (const token of tokens) {
    const id = SCOPE_ID_BY_LOWERCASE[token.toLowerCase()]
    if (id === undefined) {
      throw new Error(`Unknown scope "${token}". Valid scopes: ${SCOPE_IDS.join(', ')}.`)
    }
    selected.add(id)
  }

  const ids = SCOPE_IDS.filter((id) => selected.has(id))
  return { ids, permissions: ids.map((id) => SCOPE_PERMISSIONS[id]) }
}

/** Human-readable scope list for confirmations; `undefined` renders as "all". */
export function describeScopes(ids?: string[]): string {
  if (ids === undefined) return `all (${SCOPE_IDS.join(', ')})`
  return ids.join(', ')
}
