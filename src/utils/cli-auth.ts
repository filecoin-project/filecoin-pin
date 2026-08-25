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

/**
 * Where a resolved auth option value came from. Mirrors Commander's
 * `getOptionValueSource()`, narrowed to the two sources we distinguish for
 * precedence: an explicit command-line flag versus an environment variable.
 */
export type AuthOptionSource = 'cli' | 'env'

/**
 * Per-option provenance for the mutually exclusive auth flags, keyed by the
 * Commander attribute name. Populated by the `addAuthOptions` preAction hook
 * (see `collectAuthOptionSources` in cli-options.ts) so `parseCLIAuth` can tell
 * an explicit flag from an inherited env var. Absent for programmatic callers,
 * which are treated as if every supplied value were an explicit flag.
 */
export interface AuthOptionSources {
  privateKey?: AuthOptionSource
  walletAddress?: AuthOptionSource
  sessionKey?: AuthOptionSource
  viewAddress?: AuthOptionSource
}

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
  /**
   * Provenance of the auth flags above, injected by the `addAuthOptions`
   * preAction hook. Used only to resolve precedence; never forwarded to the SDK.
   */
  optionSources?: AuthOptionSources | undefined
  /** Filecoin network: mainnet or calibration */
  network?: string | undefined
  /** RPC endpoint URL (overrides network if specified) */
  rpcUrl?: string | undefined
  /**
   * Provider ID overrides. Holds values from the canonical repeatable
   * `--provider-id` flag and the deprecated comma-separated `--provider-ids`
   * alias, which the CLI layer merges into this array at parse time.
   */
  providerIds?: string[] | undefined
  /**
   * Data set ID overrides. Holds values from the canonical repeatable
   * `--data-set-id` flag and the deprecated `--data-set-ids` (comma-separated)
   * and `--data-set` (single-value) aliases, which the CLI layer merges into
   * this array at parse time.
   */
  dataSetIds?: string[] | undefined
}

/**
 * The mutually exclusive authentication modes, in precedence order. When more
 * than one mode is supplied, resolution is by source, not by this order: an
 * explicit flag always wins over an environment variable (see
 * {@link resolveAuthMode}). This order only fixes how conflicts are reported and
 * documents the canonical hierarchy.
 *
 * 1. `readOnly`   - `--view-address` / `VIEW_ADDRESS` (query only, never signs)
 * 2. `sessionKey` - `--wallet-address` + `--session-key` (delegated signer)
 * 3. `privateKey` - `--private-key` / `PRIVATE_KEY` (raw-key owner signer)
 *
 * Devnet auto-resolves the devnet user's private key, but only when none of the
 * above is supplied, so it is a fallback rather than a competing mode.
 */
type AuthMode = 'readOnly' | 'sessionKey' | 'privateKey'

interface AuthModeCandidate {
  mode: AuthMode
  source: AuthOptionSource
  /** Human-readable flag/env pair for conflict messages. */
  label: string
}

/**
 * Resolve which single auth mode to use from the modes that were supplied.
 *
 * Rules (see {@link AuthMode} for the mode list):
 * - An explicit command-line flag always beats an environment variable, so a
 *   flag disambiguates against any env-sourced mode.
 * - Two or more modes from explicit flags is a hard error (contradictory args).
 * - With no explicit flag, two or more env-sourced modes is a hard error; the
 *   user must pass an explicit flag to disambiguate.
 * - Exactly one supplied mode wins; none supplied returns `undefined` (caller
 *   applies the devnet fallback or lets initializeSynapse report missing auth).
 *
 * Programmatic callers that don't provide `optionSources` have every supplied
 * value treated as an explicit flag, so any two modes still conflict.
 */
function resolveAuthMode(candidates: AuthModeCandidate[]): AuthMode | undefined {
  const conflict = (modes: AuthModeCandidate[], envOnly: boolean): Error => {
    const labels = modes.map((c) => c.label).join(' and ')
    const hint = envOnly ? ' Pass an explicit flag to disambiguate.' : ''
    return new Error(`Conflicting authentication options: ${labels}. Provide exactly one signing mode.${hint}`)
  }

  const explicit = candidates.filter((c) => c.source === 'cli')
  if (explicit.length > 1) throw conflict(explicit, false)
  const [singleExplicit] = explicit
  if (singleExplicit) return singleExplicit.mode

  // No explicit flag: every remaining candidate is env-sourced.
  if (candidates.length > 1) throw conflict(candidates, true)
  return candidates[0]?.mode
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
export async function parseCLIAuth(options: CLIAuthOptions): Promise<SynapseSetupConfig> {
  const network = options.network?.toLowerCase().trim()
  const isDevnet = network === 'devnet'
  const hasRpcUrl = options.rpcUrl != null && options.rpcUrl !== ''

  // Env vars are bound to the Commander options via .env() (see cli-options.ts),
  // so read everything from `options` rather than process.env here.
  const walletAddress = options.walletAddress
  const sessionKey = options.sessionKey
  const viewAddress = options.viewAddress
  const rpcUrl = getRpcUrl(options)

  const sources = options.optionSources
  const nonEmpty = (value?: string): value is string => value != null && value !== ''
  // Effective source of one option: its Commander provenance when known,
  // otherwise treat a supplied value as an explicit flag (programmatic callers).
  const sourceOf = (name: keyof AuthOptionSources, value?: string): AuthOptionSource | undefined =>
    nonEmpty(value) ? (sources?.[name] ?? 'cli') : undefined
  // A mode spanning several options takes the strongest source among them: a
  // single explicit flag makes the whole mode explicit.
  const strongest = (...srcs: Array<AuthOptionSource | undefined>): AuthOptionSource | undefined =>
    srcs.includes('cli') ? 'cli' : srcs.includes('env') ? 'env' : undefined

  // Build the candidate list in canonical priority order (see AuthMode).
  const candidates: AuthModeCandidate[] = []
  const readOnlySource = sourceOf('viewAddress', viewAddress)
  if (readOnlySource)
    candidates.push({ mode: 'readOnly', source: readOnlySource, label: '--view-address/VIEW_ADDRESS' })
  // Session-key mode competes for precedence only when BOTH halves are present.
  // A lone --wallet-address or --session-key is a lowest-priority fallback
  // (handled in the default branch), so it never outranks a complete mode like
  // a private key.
  const walletAddressSource = sourceOf('walletAddress', walletAddress)
  const sessionKeySource = sourceOf('sessionKey', sessionKey)
  const sessionSource =
    walletAddressSource && sessionKeySource ? strongest(walletAddressSource, sessionKeySource) : undefined
  if (sessionSource)
    candidates.push({ mode: 'sessionKey', source: sessionSource, label: '--wallet-address/--session-key' })
  const privateKeySource = sourceOf('privateKey', options.privateKey)
  if (privateKeySource)
    candidates.push({ mode: 'privateKey', source: privateKeySource, label: '--private-key/PRIVATE_KEY' })

  const mode = resolveAuthMode(candidates)

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

  // Build the config for the single resolved mode; initializeSynapse() validates
  // the final shape.
  const config: {
    privateKey?: string
    walletAddress?: string
    sessionKey?: string
    readOnly?: boolean
    rpcUrl?: string
    chain?: Chain
  } = {}

  switch (mode) {
    case 'readOnly':
      if (nonEmpty(viewAddress)) config.walletAddress = viewAddress
      config.readOnly = true
      break
    case 'sessionKey':
      // Both halves are present (that is what made this a competing candidate).
      if (nonEmpty(walletAddress)) config.walletAddress = walletAddress
      if (nonEmpty(sessionKey)) config.sessionKey = sessionKey
      break
    case 'privateKey':
      if (nonEmpty(options.privateKey)) config.privateKey = options.privateKey
      break
    default: {
      // No complete auth mode won. Fallbacks, in priority order: devnet
      // auto-key, then a lone session-key half passed through so
      // initializeSynapse can emit its targeted "requires both" error.
      const devnetKey = isDevnet ? resolveDevnetConfig().privateKey : undefined
      if (nonEmpty(devnetKey)) {
        config.privateKey = devnetKey
      } else if (nonEmpty(walletAddress)) {
        config.walletAddress = walletAddress
      } else if (nonEmpty(sessionKey)) {
        config.sessionKey = sessionKey
      }
      break
    }
  }
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
  /**
   * Values from the canonical flag. The CLI layer already merges the deprecated
   * aliases into this array (see `collectDeprecatedAliasId` in cli-options.ts),
   * so it covers both the canonical flag and every deprecated alias.
   */
  canonical?: string[] | undefined
  /** Value from the environment variable */
  env?: string | undefined
  label: string
}

/**
 * Gather IDs from the canonical flag (which already includes any deprecated
 * alias values) and env, in that precedence: the flag fully replaces env rather
 * than merging. Returns `provided: false` when no source supplied any value.
 */
function gatherIdSelection(source: IdSelectionSource): { provided: boolean; ids: bigint[] } {
  const raw: string[] = []
  if (source.canonical != null && source.canonical.length > 0) {
    raw.push(...source.canonical)
  } else {
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
    env: process.env.PROVIDER_IDS,
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
    env: process.env.DATA_SET_IDS,
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
    throw new Error(
      'Cannot specify both provider IDs (--provider-id/PROVIDER_IDS) and data set IDs (--data-set-id/DATA_SET_IDS). Use one or the other.'
    )
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
  const authConfig = await parseCLIAuth(options)
  const logger = getCLILogger()
  return initializeSynapse(authConfig, logger)
}
