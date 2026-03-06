/**
 * CLI Authentication Helpers
 *
 * Shared utilities for parsing authentication options from CLI commands
 * and preparing them for use with the Synapse SDK.
 */

import type { Chain, Synapse } from '@filoz/synapse-sdk'
import { getConfiguredChain, getRpcUrl } from '../common/get-rpc-url.js'
import type { SynapseSetupConfig } from '../core/synapse/index.js'
import { initializeSynapse } from '../core/synapse/index.js'
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
  /** View-only wallet address (no signing) */
  viewAddress?: string | undefined
  /** Filecoin network: mainnet or calibration */
  network?: string | undefined
  /** Commander shorthand for --network mainnet */
  mainnet?: boolean | undefined
  /** RPC endpoint URL (overrides network if specified) */
  rpcUrl?: string | undefined
  /** Optional provider ID overrides (comma-separated) */
  providerIds?: string | undefined
  /** Optional data set ID overrides (comma-separated) */
  dataSetIds?: string | undefined
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
  const viewAddress = options.viewAddress || process.env.VIEW_ADDRESS
  const rpcUrl = getRpcUrl(options)
  const chain = getConfiguredChain(options)

  // Build config incrementally; initializeSynapse() validates the final shape
  const config: {
    privateKey?: string
    walletAddress?: string
    sessionKey?: string
    readOnly?: boolean
    rpcUrl?: string
    chain?: Chain
  } = {}

  if (privateKey) config.privateKey = privateKey
  if (viewAddress) {
    config.walletAddress = viewAddress
    config.readOnly = true
  } else if (walletAddress) {
    config.walletAddress = walletAddress
  }
  if (sessionKey) config.sessionKey = sessionKey
  if (rpcUrl) config.rpcUrl = rpcUrl
  if (chain) config.chain = chain
  return config as SynapseSetupConfig
}

/**
 * Context selection options for upload (provider IDs and/or data set IDs)
 */
export interface ContextSelectionOptions {
  /** Provider ID overrides for targeting specific providers */
  providerIds?: bigint[]
  /** Data set ID overrides for targeting specific data sets */
  dataSetIds?: bigint[]
}

/**
 * Parse a comma-separated list of numeric IDs, validating and deduplicating.
 * Returns bigint[] since all downstream consumers (SDK, contracts) use bigint.
 * Throws on non-numeric values or duplicate IDs.
 */
function parseIdList(raw: string, label: string): bigint[] {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')

  const ids: bigint[] = []
  for (const part of parts) {
    try {
      ids.push(BigInt(part))
    } catch {
      throw new Error(`Invalid ${label}: "${raw}". Provide comma-separated numeric IDs.`)
    }
  }

  const unique = [...new Set(ids)]
  if (unique.length !== ids.length) {
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
    throw new Error(`Duplicate ${label}: ${[...new Set(dupes)].join(', ')}`)
  }

  return ids
}

/**
 * Parse context selection from CLI options and environment variables.
 *
 * Reads provider IDs from --provider-ids / PROVIDER_IDS and
 * data set IDs from --data-set-ids / DATA_SET_IDS. Both accept
 * comma-separated numeric values. They are mutually exclusive.
 *
 * @param options - CLI authentication options (may contain provider/data-set fields)
 * @returns Context selection options
 */
export function parseContextSelectionOptions(options?: CLIAuthOptions): ContextSelectionOptions {
  const providerRaw = (options?.providerIds || process.env.PROVIDER_IDS)?.trim()
  const dataSetRaw = (options?.dataSetIds || process.env.DATA_SET_IDS)?.trim()

  const hasProviders = providerRaw != null && providerRaw !== ''
  const hasDataSets = dataSetRaw != null && dataSetRaw !== ''

  if (hasProviders && hasDataSets) {
    throw new Error('Cannot specify both --provider-ids and --data-set-ids. Use one or the other.')
  }

  if (hasProviders) {
    return { providerIds: parseIdList(providerRaw, 'provider ID(s)') }
  }
  if (hasDataSets) {
    return { dataSetIds: parseIdList(dataSetRaw, 'data set ID(s)') }
  }
  return {}
}

/**
 * Get a logger instance for use in CLI commands
 *
 * @returns Logger configured for CLI use
 */
export function getCLILogger() {
  return createLogger({ logLevel: process.env.LOG_LEVEL })
}

export async function getCliSynapse(options: CLIAuthOptions): Promise<Synapse> {
  const authConfig = parseCLIAuth(options)
  const logger = getCLILogger()
  return initializeSynapse(authConfig, logger)
}
