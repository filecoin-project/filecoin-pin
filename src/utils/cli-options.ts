/**
 * Shared CLI options for commands
 *
 * This module provides reusable option definitions for Commander.js commands
 * to ensure consistency across all CLI commands.
 */
import { type Command, InvalidArgumentError, Option } from 'commander'
import { parseUnits } from 'viem'
import { MIN_RUNWAY_DAYS } from '../common/constants.js'
import { normalizeNetworkName } from '../common/get-rpc-url.js'
import { USDFC_DECIMALS } from '../core/payments/constants.js'
import { log } from './cli-logger.js'

/**
 * Option factories for flags declared on more than one command. Each pairs a
 * flag with its backing env var exactly once; only the description varies per
 * command. `--help` shows the env var (e.g. `[env: PRIVATE_KEY]`) and the CLI
 * flag wins over the env var.
 */
export function privateKeyOption(description: string): Option {
  return new Option('--private-key <key>', description).env('PRIVATE_KEY')
}

export function sessionKeyOption(description: string): Option {
  return new Option('--session-key <key>', description).env('SESSION_KEY')
}

export function rpcUrlOption(description: string): Option {
  return new Option('--rpc-url <url>', description).env('RPC_URL')
}

/**
 * Add the signing-auth flags shared by every authenticated command:
 * `--private-key`, `--wallet-address`, `--session-key`.
 *
 * Each is declared via `new Option().env(...)` so `--help` shows the backing
 * env var (e.g. `[env: PRIVATE_KEY]`). The CLI flag still wins over the env var.
 * Used by {@link addAuthOptions} and directly by the `server` command (which
 * does not support view-only auth, so it omits `--view-address`).
 */
export function addSigningAuthOptions(command: Command): Command {
  return command
    .addOption(privateKeyOption('Private key for standard auth'))
    .addOption(new Option('--wallet-address <address>', 'Wallet address for session key auth').env('WALLET_ADDRESS'))
    .addOption(sessionKeyOption('Session key for session key auth'))
}

/**
 * Decorator to add common authentication options to a Commander command
 *
 * This adds the standard set of authentication options that all commands need:
 * - --private-key for standard authentication
 * - --wallet-address for session key authentication
 * - --session-key for session key authentication
 * - --view-address for read-only authentication (no signing, requires wallet address)
 * - --network for network selection (mainnet or calibration)
 * - --rpc-url for network configuration (overrides --network)
 *
 * The function modifies the command in-place and returns it for chaining.
 *
 * @param command - The Commander command to add options to
 * @returns The same command with options added (for chaining)
 *
 * @example
 * ```typescript
 * // Define command with its specific options and action
 * const myCommand = new Command('mycommand')
 *   .description('Do something')
 *   .option('--my-option <value>', 'My custom option')
 *   .action(async (options) => {
 *     // options will include: privateKey, walletAddress, sessionKey, viewAddress, network, rpcUrl, myOption
 *     const { privateKey, walletAddress, sessionKey, viewAddress, network, rpcUrl, myOption } = options
 *   })
 *
 * // Add authentication options after the command is fully defined
 * addAuthOptions(myCommand)
 * ```
 */
export function addAuthOptions(command: Command): Command {
  addSigningAuthOptions(command).addOption(
    new Option('--view-address <address>', 'View-only mode (no signing) for the specified wallet address').env(
      'VIEW_ADDRESS'
    )
  )

  return addNetworkOptions(command).addOption(
    rpcUrlOption('RPC endpoint')
    // default rpcUrl value is defined in ../common/get-rpc-url.ts
  )
}

/**
 * Commander arg parser that accumulates repeated option values into an array.
 */
function collectId(value: string, previous: string[] = []): string[] {
  previous.push(value)
  return previous
}

/**
 * Arg parser for a deprecated alias (comma-separated or single-value). Warns on
 * use and pushes the raw value onto the *canonical* array (the alias shares the
 * canonical attribute). A comma-separated value is split downstream by
 * `toIdList`, so no splitting is needed here.
 *
 * Commander runs an option's arg parser once per occurrence of the flag, so the
 * closure tracks whether it has already warned to emit at most one line per
 * deprecated flag even when the flag is repeated. The flag is per-closure (one
 * closure per option per command), so distinct flags each still warn once.
 */
function collectDeprecatedAliasId(canonicalFlag: string, deprecatedFlag: string) {
  let warned = false
  return (value: string, previous: string[] = []): string[] => {
    if (!warned) {
      log.warn(`${deprecatedFlag} is deprecated; use ${canonicalFlag} instead.`)
      warned = true
    }
    previous.push(value)
    return previous
  }
}

/**
 * Commander derives an option's stored attribute name from its long flag
 * (`--data-set-id` → `dataSetId`). That makes a repeatable *singular* flag
 * surface in code as a singular field holding an array (`dataSetId: ['1']`),
 * which is confusing. There is no public setter for the attribute name, so we
 * override the (public) `attributeName()` method on the instance to store the
 * value under an explicit key. This lets the canonical flags stay singular
 * (`--provider-id`, `--data-set-id`) while their values live under the plural
 * `providerIds`/`dataSetIds` in code. The deprecated comma aliases share the
 * same plural attribute so their values merge into the canonical array at parse
 * time, keeping the in-code option shape to a single field per selection.
 */
function withAttributeName(option: Option, attributeName: string): Option {
  option.attributeName = () => attributeName
  return option
}

/**
 * Add the canonical repeatable `--provider-id` flag plus its deprecated
 * `--provider-ids` (comma-separated) alias.
 *
 * Parsing/validation of the gathered values happens in
 * {@link import('./cli-auth.js').parseProviderIdSelection}.
 */
export function addProviderIdOption(command: Command): Command {
  return command
    .addOption(
      withAttributeName(
        // PROVIDER_IDS is intentionally NOT bound via .env(): gatherIdSelection
        // (cli-auth.ts) comma-splits the env value and lets a flag fully
        // replace it. Binding .env() here would feed the raw env string
        // through collectId and leave that read dead, so the env var is named
        // in the description instead.
        new Option(
          '--provider-id <id>',
          'Target a specific provider by ID; repeatable (can also use PROVIDER_IDS env)'
        ).argParser(collectId),
        'providerIds'
      )
    )
    .addOption(
      withAttributeName(
        new Option('--provider-ids <ids>', 'Deprecated alias for --provider-id (comma-separated)')
          .hideHelp()
          .argParser(collectDeprecatedAliasId('--provider-id', '--provider-ids')),
        'providerIds'
      )
    )
}

export interface DataSetIdOptionConfig {
  /** Also register the hidden, deprecated `--data-set <id>` single-value alias (used by `rm`). */
  includeSingleAlias?: boolean
}

/**
 * Add the canonical repeatable `--data-set-id` flag plus its deprecated
 * `--data-set-ids` (comma-separated) alias, and optionally the deprecated
 * single-value `--data-set` alias.
 */
export function addDataSetIdOption(command: Command, config: DataSetIdOptionConfig = {}): Command {
  command
    .addOption(
      withAttributeName(
        // DATA_SET_IDS is intentionally NOT bound via .env(); see the
        // PROVIDER_IDS note in addProviderIdOption.
        new Option(
          '--data-set-id <id>',
          'Target a specific data set by ID; repeatable (can also use DATA_SET_IDS env)'
        ).argParser(collectId),
        'dataSetIds'
      )
    )
    .addOption(
      withAttributeName(
        new Option('--data-set-ids <ids>', 'Deprecated alias for --data-set-id (comma-separated)')
          .hideHelp()
          .argParser(collectDeprecatedAliasId('--data-set-id', '--data-set-ids')),
        'dataSetIds'
      )
    )
  if (config.includeSingleAlias) {
    command.addOption(
      withAttributeName(
        new Option('--data-set <id>', 'Deprecated alias for --data-set-id')
          .hideHelp()
          .argParser(collectDeprecatedAliasId('--data-set-id', '--data-set')),
        'dataSetIds'
      )
    )
  }
  return command
}

/**
 * Decorator to add context selection options to a Commander command
 *
 * Adds repeatable `--provider-id` and `--data-set-id` for overriding automatic
 * selection. These are mutually exclusive (enforced in parseContextSelectionOptions).
 *
 * @param command - The Commander command to add options to
 * @returns The same command with options added (for chaining)
 */
export function addContextSelectionOptions(command: Command): Command {
  addProviderIdOption(command)
  addDataSetIdOption(command)
  return command
}

/**
 * Add owner-signing options (`--private-key`, `--network`, `--rpc-url`) to a
 * command.
 */
export function addOwnerAuthOptions(command: Command): Command {
  return addNetworkOptions(command.addOption(privateKeyOption('Owner private key for signing'))).addOption(
    rpcUrlOption('RPC endpoint')
  )
}

const ALLOWED_NETWORKS = ['mainnet', 'calibration', 'devnet']

export function addNetworkOptions(command: Command): Command {
  command.addOption(
    new Option(
      '--network <network>',
      'Filecoin network to use (default: mainnet). Mutually exclusive with --rpc-url. "devnet" reads ' +
        'config from foc-devnet (https://github.com/filecoin-project/foc-devnet, ' +
        'env: FOC_DEVNET_BASEDIR or DEVNET_INFO_PATH, DEVNET_USER_INDEX).'
    )
      // .choices() keeps --help limited to the canonical names AND installs its
      // own arg parser. A later .argParser() replaces that parser, so it must
      // both normalize aliases (e.g. calibnet) and re-validate the result.
      .choices(ALLOWED_NETWORKS)
      .argParser((value) => {
        const normalized = normalizeNetworkName(value) ?? value
        if (!ALLOWED_NETWORKS.includes(normalized)) {
          throw new InvalidArgumentError(`Allowed choices are ${ALLOWED_NETWORKS.join(', ')}.`)
        }
        return normalized
      })
      .env('NETWORK')
      .conflicts('rpcUrl')
  )
  return command
}

/**
 * Add upload-specific options to a command.
 * Used by `add` and `import` commands.
 */
export function addUploadOptions(command: Command): Command {
  return command
    .addOption(
      new Option(
        '--skip-ipni-verification',
        'Skip IPNI advertisement verification after upload (automatic for devnet)'
      ).env('SKIP_IPNI_VERIFICATION')
    )
    .addOption(
      new Option(
        '--dry-run',
        'Estimate upload cost and required deposit, then exit without uploading or moving funds'
      ).conflicts('autoFund')
    )
}

/**
 * Auto-fund option fields shared by `add` and `import` runner option types.
 * Extend this on command-specific option interfaces so additions ripple through.
 */
export interface CLIAutoFundOptions {
  autoFund?: boolean
  minRunwayDays?: number
  maxBalance?: bigint
}

/**
 * Add auto-fund options to a command.
 * Used by `add` and `import` commands. Modifiers require `--auto-fund`; validate
 * post-parse with {@link validateAndNormalizeAutoFundOptions}.
 */
export function addAutoFundOptions(command: Command): Command {
  return command
    .addOption(
      new Option(
        '--auto-fund',
        `Automatically deposit USDFC before upload to maintain runway (default: ${MIN_RUNWAY_DAYS} days)`
      ).conflicts('viewAddress')
    )
    .option(
      '--min-runway-days <n>',
      'Minimum days of runway to maintain when auto-funding (requires --auto-fund)',
      (v) => {
        if (!/^\d+$/.test(v)) {
          throw new InvalidArgumentError('Must be a positive integer.')
        }
        return Number(v)
      }
    )
    .option('--max-balance <usdfc>', 'Maximum Filecoin Pay balance after deposit, e.g. 5.00 (requires --auto-fund)')
}

/**
 * Validate and normalize auto-fund options parsed by Commander.
 *
 * Strict mode: `--min-runway-days` and `--max-balance` require `--auto-fund` (no implicit
 * activation). The `--auto-fund` / `--view-address` conflict is enforced by Commander's
 * `.conflicts()` on the option declaration itself.
 *
 * @throws Error with a flag-specific message on validation failure
 */
export function validateAndNormalizeAutoFundOptions(raw: {
  autoFund?: boolean
  minRunwayDays?: number
  maxBalance?: string
}): CLIAutoFundOptions {
  const autoFund = raw.autoFund === true

  if (raw.minRunwayDays !== undefined && !autoFund) {
    throw new Error('--min-runway-days requires --auto-fund')
  }
  if (raw.maxBalance !== undefined && !autoFund) {
    throw new Error('--max-balance requires --auto-fund')
  }

  let minRunwayDays: number | undefined
  if (raw.minRunwayDays !== undefined) {
    if (!Number.isFinite(raw.minRunwayDays) || !Number.isInteger(raw.minRunwayDays) || raw.minRunwayDays <= 0) {
      throw new Error(`--min-runway-days must be a positive integer, got: ${raw.minRunwayDays}`)
    }
    minRunwayDays = raw.minRunwayDays
  }

  let maxBalance: bigint | undefined
  if (raw.maxBalance !== undefined) {
    try {
      maxBalance = parseUnits(raw.maxBalance, USDFC_DECIMALS)
    } catch {
      throw new Error(`--max-balance must be a USDFC decimal value (e.g. 5.00), got: ${raw.maxBalance}`)
    }
    if (maxBalance < 0n) {
      throw new Error(`--max-balance must be non-negative, got: ${raw.maxBalance}`)
    }
  }

  const result: CLIAutoFundOptions = { autoFund }
  if (minRunwayDays !== undefined) result.minRunwayDays = minRunwayDays
  if (maxBalance !== undefined) result.maxBalance = maxBalance
  return result
}
