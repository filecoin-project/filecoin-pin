/**
 * CLI Authentication Helpers
 *
 * Shared utilities for parsing authentication options from CLI commands
 * and preparing them for use with the Synapse SDK.
 */

import type { Chain, Synapse } from '@filoz/synapse-sdk'
import { getRpcUrl, NETWORK_CHAINS, resolveDevnetConfig } from '../common/get-rpc-url.js'
import type { SynapseSetupConfig } from '../core/synapse/index.js'
import { initializeSynapse } from '../core/synapse/index.js'
import { createLogger } from '../logger.js'
import { log } from './cli-logger.js'

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
  /** RPC endpoint URL (overrides network if specified) */
  rpcUrl?: string | undefined
  /** Provider ID overrides from the canonical repeatable `--provider-id` flag */
  providerIds?: string[] | undefined
  /** Data set ID overrides from the canonical repeatable `--data-set-id` flag */
  dataSetIds?: string[] | undefined
  /** @deprecated comma-separated alias for {@link providerIds} (`--provider-ids`) */
  providerIdsCsv?: string | undefined
  /** @deprecated comma-separated alias for {@link dataSetIds} (`--data-set-ids`) */
  dataSetIdsCsv?: string | undefined
  /** @deprecated single-value alias for {@link dataSetIds} (`--data-set`, used by `rm`) */
  dataSet?: string | undefined
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
  const network = options.network?.toLowerCase().trim()
  const isDevnet = network === 'devnet'
  const hasRpcUrl = options.rpcUrl != null && options.rpcUrl !== ''

  // For devnet, fall back to the devnet user's private key if none provided
  const privateKey =
    options.privateKey || process.env.PRIVATE_KEY || (isDevnet ? resolveDevnetConfig().privateKey : undefined)
  const walletAddress = options.walletAddress || process.env.WALLET_ADDRESS
  const sessionKey = options.sessionKey || process.env.SESSION_KEY
  const viewAddress = options.viewAddress || process.env.VIEW_ADDRESS
  const rpcUrl = getRpcUrl(options)

  // --network and --rpc-url are mutually exclusive at the Commander level. Set the chain hint
  // only when --network was chosen; otherwise leave it undefined and let initializeSynapse probe
  // the RPC endpoint. When neither is supplied, default to mainnet.
  let chain: Chain | undefined
  if (isDevnet) {
    chain = resolveDevnetConfig().chain
  } else if (network) {
    chain = NETWORK_CHAINS[network as keyof typeof NETWORK_CHAINS]
  } else if (!hasRpcUrl) {
    chain = NETWORK_CHAINS.mainnet
  }

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
 * Validate and deduplicate raw ID strings into a bigint[].
 * Each raw value may itself be comma-separated (aliases/env supply lists).
 * Returns bigint[] since all downstream consumers (SDK, contracts) use bigint.
 * Throws on empty input, non-numeric values, or duplicate IDs.
 */
function toIdList(rawValues: string[], label: string): bigint[] {
  const parts = rawValues.flatMap((value) =>
    value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
  )

  if (parts.length === 0) {
    throw new Error(`Invalid ${label}: no IDs provided. Provide one or more numeric IDs.`)
  }

  const ids: bigint[] = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      throw new Error(`Invalid ${label}: "${part}". Provide positive numeric IDs.`)
    }
    const id = BigInt(part)
    if (id <= 0n) {
      throw new Error(`Invalid ${label}: "${part}". Provide positive numeric IDs.`)
    }
    ids.push(id)
  }

  const unique = [...new Set(ids)]
  if (unique.length !== ids.length) {
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
    throw new Error(`Duplicate ${label}: ${[...new Set(dupes)].join(', ')}`)
  }

  return ids
}

interface IdSelectionSource {
  /** Values from the canonical repeatable flag */
  canonical?: string[] | undefined
  /** Value from the deprecated comma-separated alias */
  commaAlias?: string | undefined
  /** Value from the deprecated single-value alias */
  singleAlias?: string | undefined
  /** Value from the environment variable */
  env?: string | undefined
  canonicalFlag: string
  commaAliasFlag: string
  singleAliasFlag?: string | undefined
  label: string
}

/**
 * Gather IDs from the canonical flag, deprecated aliases, and env (in that
 * precedence). Emits a deprecation warning for each deprecated source used.
 * Returns `provided: false` when no source supplied any value.
 */
function gatherIdSelection(source: IdSelectionSource): { provided: boolean; ids: bigint[] } {
  const raw: string[] = []

  if (source.canonical != null) {
    raw.push(...source.canonical)
  }

  const commaAlias = source.commaAlias?.trim()
  if (commaAlias != null && commaAlias !== '') {
    log.warn(`${source.commaAliasFlag} is deprecated; use ${source.canonicalFlag} instead.`)
    raw.push(commaAlias)
  }

  const singleAlias = source.singleAlias?.trim()
  if (source.singleAliasFlag != null && singleAlias != null && singleAlias !== '') {
    log.warn(`${source.singleAliasFlag} is deprecated; use ${source.canonicalFlag} instead.`)
    raw.push(singleAlias)
  }

  if (raw.length === 0) {
    const env = source.env?.trim()
    if (env != null && env !== '') {
      raw.push(env)
    }
  }

  if (raw.length === 0) {
    return { provided: false, ids: [] }
  }

  return { provided: true, ids: toIdList(raw, source.label) }
}

/**
 * Parse provider IDs from `--provider-id` (repeatable), the deprecated
 * `--provider-ids` alias, and the `PROVIDER_IDS` env var.
 */
export function parseProviderIdSelection(options?: CLIAuthOptions): bigint[] {
  return gatherIdSelection({
    canonical: options?.providerIds,
    commaAlias: options?.providerIdsCsv,
    env: process.env.PROVIDER_IDS,
    canonicalFlag: '--provider-id',
    commaAliasFlag: '--provider-ids',
    label: 'provider ID(s)',
  }).ids
}

/**
 * Parse data set IDs from `--data-set-id` (repeatable), the deprecated
 * `--data-set-ids` / `--data-set` aliases, and the `DATA_SET_IDS` env var.
 */
export function parseDataSetIdSelection(options?: CLIAuthOptions): bigint[] {
  return gatherIdSelection({
    canonical: options?.dataSetIds,
    commaAlias: options?.dataSetIdsCsv,
    singleAlias: options?.dataSet,
    env: process.env.DATA_SET_IDS,
    canonicalFlag: '--data-set-id',
    commaAliasFlag: '--data-set-ids',
    singleAliasFlag: '--data-set',
    label: 'data set ID(s)',
  }).ids
}

/**
 * Parse context selection from CLI options and environment variables.
 *
 * Reads provider IDs from `--provider-id` / `PROVIDER_IDS` and data set IDs
 * from `--data-set-id` / `DATA_SET_IDS`. The deprecated `--provider-ids`,
 * `--data-set-ids`, and `--data-set` aliases are still accepted (with a
 * warning). Provider and data set selection are mutually exclusive.
 *
 * @param options - CLI authentication options (may contain provider/data-set fields)
 * @returns Context selection options
 */
export function parseContextSelectionOptions(options?: CLIAuthOptions): ContextSelectionOptions {
  const providerIds = parseProviderIdSelection(options)
  const dataSetIds = parseDataSetIdSelection(options)

  if (providerIds.length > 0 && dataSetIds.length > 0) {
    throw new Error('Cannot specify both provider IDs and data set IDs. Use one or the other.')
  }

  if (providerIds.length > 0) {
    return { providerIds }
  }
  if (dataSetIds.length > 0) {
    return { dataSetIds }
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
