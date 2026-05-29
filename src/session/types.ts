/**
 * CLI option shapes for `session` subcommands.
 */

export interface SessionCreateOptions {
  privateKey?: string
  network?: string
  rpcUrl?: string
  sessionKey?: string
  validityDays?: string
}

export interface SessionAuthorizeOptions {
  privateKey?: string
  network?: string
  rpcUrl?: string
  validityDays?: string
  /** Positional argument: the session address to authorize. */
  sessionAddress: string
}

export interface SessionRevokeOptions {
  privateKey?: string
  network?: string
  rpcUrl?: string
  /** Positional argument: the session address to revoke. */
  sessionAddress: string
}
