/**
 * `--scopes` handling for the session CLI runners. The scope map and parser
 * live in core (`src/core/session/scopes.ts`); this adds the CLI-facing
 * cancel-and-rethrow wrapper.
 */

import { type ParsedScopes, parseScopes } from '../core/session/scopes.js'
import { cancel } from '../utils/cli-helpers.js'

export {
  describeScopes,
  type ParsedScopes,
  parseScopes,
  SCOPE_IDS,
  SCOPE_PERMISSIONS,
  type ScopeId,
} from '../core/session/scopes.js'

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
