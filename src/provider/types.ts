import type { CLIAuthOptions } from '../utils/cli-auth.js'

export interface ProviderListOptions extends CLIAuthOptions {
  all?: boolean
  endorsed?: boolean
}

export interface ProviderShowOptions extends CLIAuthOptions {
  // Currently no specific options for show command, but keeping interface for consistency
}

export interface ProviderPingOptions extends CLIAuthOptions {
  all?: boolean
}
