/**
 * CLI option shapes for `session` subcommands.
 */

export interface SessionCreateOptions {
  privateKey?: string
  network?: string
  rpcUrl?: string
  sessionKey?: string
  validityDays?: string
  /** Comma-separated scope ids to grant; omitted means all FWSS permissions. */
  scopes?: string
}

export interface SessionAuthorizeOptions {
  privateKey?: string
  network?: string
  rpcUrl?: string
  validityDays?: string
  /** Comma-separated scope ids to grant; omitted means all FWSS permissions. */
  scopes?: string
  /** Positional argument: the session address to authorize. */
  sessionAddress: string
}

export interface SessionRevokeOptions {
  privateKey?: string
  network?: string
  rpcUrl?: string
  /** Comma-separated scope ids to revoke; omitted means all FWSS permissions. */
  scopes?: string
  /** Positional argument: the session address to revoke. */
  sessionAddress: string
}
