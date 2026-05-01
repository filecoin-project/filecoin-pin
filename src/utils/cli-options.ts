/**
 * Shared CLI options for commands
 *
 * This module provides reusable option definitions for Commander.js commands
 * to ensure consistency across all CLI commands.
 */
import { type Command, InvalidArgumentError, Option } from 'commander'
import { parseUnits } from 'viem'
import { MIN_RUNWAY_DAYS } from '../common/constants.js'
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
export function addAuthOptions(command: Command): Command {
  command
    .option('--private-key <key>', 'Private key for standard auth (can also use PRIVATE_KEY env)')
    .option('--wallet-address <address>', 'Wallet address for session key auth (can also use WALLET_ADDRESS env)')
    .option('--session-key <key>', 'Session key for session key auth (can also use SESSION_KEY env)')
    .addOption(
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
      new Option(
        '--provider-ids <ids>',
        'Target specific providers by ID, comma-separated (can also use PROVIDER_IDS env)'
      ).conflicts('dataSetIds')
    )
    .addOption(
      new Option(
        '--data-set-ids <ids>',
        'Target specific data sets by ID, comma-separated (can also use DATA_SET_IDS env)'
      ).conflicts('providerIds')
    )
}

export function addNetworkOptions(command: Command): Command {
  command
    .addOption(
      new Option(
        '--network <network>',
        'Filecoin network to use. "devnet" reads config from foc-devnet ' +
          '(https://github.com/filecoin-project/foc-devnet, ' +
          'env: FOC_DEVNET_BASEDIR or DEVNET_INFO_PATH, DEVNET_USER_INDEX)'
      )
        .choices(['mainnet', 'calibration', 'devnet'])
        .env('NETWORK')
        .default('calibration')
    )
    .addOption(new Option('--mainnet', 'Use mainnet (shorthand for --network mainnet)').implies({ network: 'mainnet' }))
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
 * Add auto-fund options to a command.
 * Used by `add` and `import` commands. Modifiers require `--auto-fund`; validate
 * post-parse with {@link validateAndNormalizeAutoFundOptions}.
 */
export function addAutoFundOptions(command: Command): Command {
  return command
    .option(
      '--auto-fund',
      `Automatically deposit USDFC before upload to maintain runway (default: ${MIN_RUNWAY_DAYS} days)`
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

export interface NormalizedAutoFundOptions {
  autoFund: boolean
  minRunwayDays?: number
  maxBalance?: bigint
}

/**
 * Validate and normalize auto-fund options parsed by Commander.
 *
 * Strict mode: `--min-runway-days` and `--max-balance` require `--auto-fund` (no implicit
 * activation). `--view-address` (read-only auth) is incompatible with `--auto-fund` since
 * deposits require a signing wallet.
 *
 * @throws Error with a flag-specific message on validation failure
 */
export function validateAndNormalizeAutoFundOptions(raw: {
  autoFund?: boolean
  minRunwayDays?: number
  maxBalance?: string
  viewAddress?: string
}): NormalizedAutoFundOptions {
  const autoFund = raw.autoFund === true

  if (raw.minRunwayDays !== undefined && !autoFund) {
    throw new Error('--min-runway-days requires --auto-fund')
  }
  if (raw.maxBalance !== undefined && !autoFund) {
    throw new Error('--max-balance requires --auto-fund')
  }
  if (autoFund && raw.viewAddress !== undefined) {
    throw new Error('--auto-fund cannot be used with --view-address (read-only mode cannot sign deposits)')
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

  const result: NormalizedAutoFundOptions = { autoFund }
  if (minRunwayDays !== undefined) result.minRunwayDays = minRunwayDays
  if (maxBalance !== undefined) result.maxBalance = maxBalance
  return result
}
