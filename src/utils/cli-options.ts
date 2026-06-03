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
    .addOption(new Option('--private-key <key>', 'Private key for standard auth').env('PRIVATE_KEY'))
    .addOption(new Option('--wallet-address <address>', 'Wallet address for session key auth').env('WALLET_ADDRESS'))
    .addOption(new Option('--session-key <key>', 'Session key for session key auth').env('SESSION_KEY'))
}

export function addAuthOptions(command: Command): Command {
  addSigningAuthOptions(command).addOption(
    new Option('--view-address <address>', 'View-only mode (no signing) for the specified wallet address').env(
      'VIEW_ADDRESS'
    )
  )

  return addNetworkOptions(command).addOption(
    new Option('--rpc-url <url>', 'RPC endpoint').env('RPC_URL')
    // default rpcUrl value is defined in ../common/get-rpc-url.ts
  )
}

/**
 * Decorator to add context selection options to a Commander command
 *
 * Adds --provider-ids and --data-set-ids for overriding automatic selection.
 * These are mutually exclusive.
 *
 * @param command - The Commander command to add options to
 * @returns The same command with options added (for chaining)
 */
export function addContextSelectionOptions(command: Command): Command {
  return command
    .addOption(
      new Option('--provider-ids <ids>', 'Target specific providers by ID, comma-separated')
        .conflicts('dataSetIds')
        .env('PROVIDER_IDS')
    )
    .addOption(
      new Option('--data-set-ids <ids>', 'Target specific data sets by ID, comma-separated')
        .conflicts('providerIds')
        .env('DATA_SET_IDS')
    )
}

/**
 * Add owner-signing options (`--private-key`, `--network`, `--rpc-url`) to a
 * command.
 */
export function addOwnerAuthOptions(command: Command): Command {
  return addNetworkOptions(
    command.option('--private-key <key>', 'Owner private key for signing (can also use PRIVATE_KEY env)')
  ).addOption(new Option('--rpc-url <url>', 'RPC endpoint').env('RPC_URL'))
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
  return command.addOption(
    new Option(
      '--skip-ipni-verification',
      'Skip IPNI advertisement verification after upload (automatic for devnet)'
    ).env('SKIP_IPNI_VERIFICATION')
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
