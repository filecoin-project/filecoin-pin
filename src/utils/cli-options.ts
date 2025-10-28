/**
 * Shared CLI options for commands
 *
 * This module provides reusable option definitions for Commander.js commands
 * to ensure consistency across all CLI commands.
 */

import { RPC_URLS } from '@filoz/synapse-sdk'
import type { Command } from 'commander'

/**
 * Decorator to add common authentication options to a Commander command
 *
 * This adds the standard set of authentication options that all commands need:
 * - --private-key for standard authentication
 * - --wallet-address for session key authentication
 * - --session-key for session key authentication
 * - --rpc-url for network configuration
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
 *     // options will include: privateKey, walletAddress, sessionKey, rpcUrl, myOption
 *     const { privateKey, walletAddress, sessionKey, rpcUrl, myOption } = options
 *   })
 *
 * // Add authentication options after the command is fully defined
 * addAuthOptions(myCommand)
 * ```
 */
export function addAuthOptions(command: Command): Command {
  return command
    .option('--private-key <key>', 'Private key for standard auth (can also use PRIVATE_KEY env)')
    .option('--wallet-address <address>', 'Wallet address for session key auth (can also use WALLET_ADDRESS env)')
    .option('--session-key <key>', 'Session key for session key auth (can also use SESSION_KEY env)')
    .option('--rpc-url <url>', 'RPC endpoint (can also use RPC_URL env)', RPC_URLS.calibration.websocket)
    .option(
      '--warm-storage-address <address>',
      'Warm storage contract address override (can also use WARM_STORAGE_ADDRESS env)'
    )
}

/**
 * Decorator to add provider selection options to a Commander command
 *
 * This adds options for overriding the automatic provider selection:
 * - --provider-address for selecting by provider address
 * - --provider-id for selecting by provider ID
 *
 * The function modifies the command in-place and returns it for chaining.
 *
 * @param command - The Commander command to add options to
 * @returns The same command with options added (for chaining)
 *
 * @example
 * ```typescript
 * const myCommand = new Command('upload')
 *   .description('Upload data')
 *   .action(async (options) => {
 *     const { providerAddress, providerId } = options
 *   })
 *
 * addProviderOptions(myCommand)
 * ```
 */
export function addProviderOptions(command: Command): Command {
  return command
    .option(
      '--provider-address <address>',
      'Override provider selection by address (can also use PROVIDER_ADDRESS env)'
    )
    .option('--provider-id <id>', 'Override provider selection by ID (can also use PROVIDER_ID env)')
}
