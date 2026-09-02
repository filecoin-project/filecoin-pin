export {
  type AuthorizeSessionOptions,
  authorizeSessionAddress,
  FilecoinPinFwssPermissions,
  MAX_VALIDITY_DAYS,
  TerminateServicePermission,
} from './authorize-session.js'
export { type CreateSessionKeyOptions, createSessionKey, generateSessionKeypair } from './create-session-key.js'
export { type RevokeSessionOptions, revokeSessionAddress } from './revoke-session.js'
export {
  describeScopes,
  type ParsedScopes,
  parseScopes,
  SCOPE_IDS,
  SCOPE_PERMISSIONS,
  type ScopeId,
  scopeIdOf,
} from './scopes.js'
export type {
  AuthorizeSessionProgressEvents,
  AuthorizeSessionResult,
  CreateSessionKeyProgressEvents,
  CreateSessionKeyResult,
  RevokeSessionProgressEvents,
  RevokeSessionResult,
  SessionKeypair,
} from './types.js'
export {
  DEFAULT_WATCH_DEADLINE_MS,
  DEFAULT_WATCH_INTERVAL_MS,
  readScopeGrants,
  type ScopeGrants,
  type WatchAuthorizationOptions,
  type WatchAuthorizationResult,
  watchAuthorization,
} from './watch-authorization.js'
