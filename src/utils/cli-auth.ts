/**
 * CLI Authentication Helpers
 *
 * Shared utilities for parsing authentication options from CLI commands
 * and preparing them for use with the Synapse SDK.
 */

import type { SynapseSetupConfig } from '../core/synapse/index.js'
import { createLogger } from '../logger.js'

/**
 * Common CLI authentication options interface
 * Used across all commands that require authentication
 */
export interface CLIAuthOptions {
  /** Private key for standard authentication */
  privateKey?: string | undefined
  /** Wallet address for session key mode */
  walletAddress?: string | undefined
  /** Session key private key */
  sessionKey?: string | undefined
  /** RPC endpoint URL */
  rpcUrl?: string | undefined
  /** Optional warm storage address override */
  warmStorageAddress?: string | undefined
  /** Optional provider address override */
  providerAddress?: string | undefined
  /** Optional provider ID override */
  providerId?: string | undefined
}

/**
 * Parse CLI authentication options into SynapseSetupConfig
 *
 * This function handles reading from CLI options and environment variables,
 * and returns a config ready for initializeSynapse().
 *
 * Note: Validation is performed by initializeSynapse() via validateAuthConfig()
 *
 * @param options - CLI authentication options
 * @returns Synapse setup config (validation happens in initializeSynapse)
 */
export function parseCLIAuth(options: CLIAuthOptions): Partial<SynapseSetupConfig> {
  // Read from CLI options or environment variables
  const privateKey = options.privateKey || process.env.PRIVATE_KEY
  const walletAddress = options.walletAddress || process.env.WALLET_ADDRESS
  const sessionKey = options.sessionKey || process.env.SESSION_KEY
  const rpcUrl = options.rpcUrl || process.env.RPC_URL
  const warmStorageAddress = options.warmStorageAddress || process.env.WARM_STORAGE_ADDRESS

  // Build config - only include defined values, validation happens in initializeSynapse()
  const config: any = {}

  if (privateKey) config.privateKey = privateKey
  if (walletAddress) config.walletAddress = walletAddress
  if (sessionKey) config.sessionKey = sessionKey
  if (rpcUrl) config.rpcUrl = rpcUrl
  if (warmStorageAddress) config.warmStorageAddress = warmStorageAddress

  return config
}

/**
 * Provider selection options for storage context
 */
export interface ProviderSelectionOptions {
  /** Provider address override */
  providerAddress?: string
  /** Provider ID override */
  providerId?: number
}

/**
 * Parse provider selection from CLI options and environment variables
 *
 * Reads provider address and ID from CLI options or environment variables,
 * parses and validates the provider ID as a number.
 *
 * @param options - CLI authentication options (may contain provider fields)
 * @returns Provider selection options ready for createStorageContext()
 */
export function parseProviderOptions(options?: CLIAuthOptions): ProviderSelectionOptions {
  // Read from CLI options or environment variables
  const providerAddress = (options?.providerAddress || process.env.PROVIDER_ADDRESS)?.trim()
  const providerIdRaw = (options?.providerId || process.env.PROVIDER_ID)?.trim()

  // Parse provider ID as number if present and non-empty
  const providerId = providerIdRaw != null && providerIdRaw !== '' ? Number(providerIdRaw) : undefined

  // Build result with only defined values
  const result: ProviderSelectionOptions = {}
  if (providerAddress) {
    result.providerAddress = providerAddress
  }
  if (providerId != null) {
    result.providerId = providerId
  }

  return result
}

/**
 * Get a logger instance for use in CLI commands
 *
 * @returns Logger configured for CLI use
 */
export function getCLILogger() {
  return createLogger({ logLevel: process.env.LOG_LEVEL })
}
