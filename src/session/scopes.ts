/**
 * Session-key scopes available for FWSS, used by the `session` subcommands'
 * `--scopes` flag. Ids are the camelCase forms of the FWSS EIP-712 operation
 * names (CreateDataSet -> createDataSet). Parsing is case-insensitive and
 * rejects unknown tokens with the valid list.
 */

import {
  AddPiecesPermission,
  CreateDataSetPermission,
  type Permission,
  SchedulePieceRemovalsPermission,
} from '@filoz/synapse-core/session-key'
import { TerminateServicePermission } from '../core/session/index.js'
import { cancel } from '../utils/cli-helpers.js'

/**
 * Scope id -> FWSS permission typehash. Key order is canonical: it drives the
 * order of parsed permissions and the display/help listing.
 */
export const SCOPE_PERMISSIONS: Record<string, Permission> = {
  createDataSet: CreateDataSetPermission,
  addPieces: AddPiecesPermission,
  schedulePieceRemovals: SchedulePieceRemovalsPermission,
  terminateService: TerminateServicePermission,
}

/** Canonical scope ids, in display order. */
export const SCOPE_IDS: string[] = Object.keys(SCOPE_PERMISSIONS)

const SCOPE_ID_BY_LOWERCASE: Record<string, string> = Object.fromEntries(SCOPE_IDS.map((id) => [id.toLowerCase(), id]))

export interface ParsedScopes {
  /** Canonical scope ids that were selected, in {@link SCOPE_IDS} order. */
  ids: string[]
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

  const selected = new Set<string>()
  for (const token of tokens) {
    const id = SCOPE_ID_BY_LOWERCASE[token.toLowerCase()]
    if (id === undefined) {
      throw new Error(`Unknown scope "${token}". Valid scopes: ${SCOPE_IDS.join(', ')}.`)
    }
    selected.add(id)
  }

  // Object.entries keeps insertion (canonical) order and types each value as
  // Permission, avoiding the `Record[string]` -> `Permission | undefined` widening.
  const chosen = Object.entries(SCOPE_PERMISSIONS).filter(([id]) => selected.has(id))
  return { ids: chosen.map(([id]) => id), permissions: chosen.map(([, permission]) => permission) }
}

/**
 * Parse an optional `--scopes` value for a CLI runner: `undefined` when the
 * flag was not given, otherwise the parsed scopes. On a bad value it prints
 * the cancellation and rethrows so the command wrapper exits 1.
 */
export function parseScopesOption(value: string | undefined): ParsedScopes | undefined {
  if (value === undefined) return undefined
  try {
    return parseScopes(value)
  } catch (error) {
    cancel(error instanceof Error ? error.message : String(error))
    throw error
  }
}

/** Human-readable scope list for confirmations; `undefined` renders as "all". */
export function describeScopes(ids?: string[]): string {
  if (ids === undefined) return `all (${SCOPE_IDS.join(', ')})`
  return ids.join(', ')
}
