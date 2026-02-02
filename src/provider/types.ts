import type { CLIAuthOptions } from '../utils/cli-auth.js'

export interface ProviderListOptions extends CLIAuthOptions {
  all?: boolean
  // Add other options here if needed in the future
}

export interface ProviderShowOptions extends CLIAuthOptions {
  // Currently no specific options for show command, but keeping interface for consistency
}

export interface ProviderPingOptions extends CLIAuthOptions {
  all?: boolean
}
