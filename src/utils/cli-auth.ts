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
export function parseCLIAuth(options: CLIAuthOptions): SynapseSetupConfig {
  // Read from CLI options or environment variables
  const privateKey = options.privateKey || process.env.PRIVATE_KEY
  const walletAddress = options.walletAddress || process.env.WALLET_ADDRESS
  const sessionKey = options.sessionKey || process.env.SESSION_KEY
  const rpcUrl = options.rpcUrl || process.env.RPC_URL
  const warmStorageAddress = options.warmStorageAddress || process.env.WARM_STORAGE_ADDRESS

  // Build config - validation happens in initializeSynapse()
  const config: SynapseSetupConfig = {
    privateKey,
    walletAddress,
    sessionKey,
    rpcUrl,
    warmStorageAddress,
  }

  return config
}

/**
 * Get a logger instance for use in CLI commands
 *
 * @returns Logger configured for CLI use
 */
export function getCLILogger() {
  return createLogger({ logLevel: process.env.LOG_LEVEL || 'info' })
}
