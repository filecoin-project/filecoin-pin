/**
 * Session key management commands
 *
 * This module provides CLI commands for creating and managing session keys
 * that allow delegated access to Synapse SDK without exposing the main private key.
 */

import { RPC_URLS } from '@filoz/synapse-sdk'
import { Command } from 'commander'
import picocolors from 'picocolors'
import { createSessionKey, formatSessionKeyOutput } from '../core/session/create-session-key.js'
import { addAuthOptions } from '../utils/cli-options.js'

export const sessionCommand = new Command('session').description(
  'Manage session keys for delegated access to Synapse SDK'
)

/**
 * Create command - generates and authorizes a new session key
 */
const createCommand = new Command('create')
  .description('Create and authorize a new session key')
  .option('--validity-days <days>', 'Number of days the session key should be valid', '10')
  .action(async (options) => {
    try {
      // Get private key from options or environment
      const privateKey = options.privateKey || process.env.PRIVATE_KEY
      if (!privateKey) {
        console.error(picocolors.red('Error: PRIVATE_KEY environment variable or --private-key option is required'))
        process.exit(1)
      }

      const validityDays = Number.parseInt(options.validityDays, 10)
      if (Number.isNaN(validityDays) || validityDays <= 0) {
        console.error(picocolors.red(`Error: Invalid validity days: ${options.validityDays}`))
        process.exit(1)
      }

      // Ensure we use HTTP RPC URL (JsonRpcProvider doesn't support WebSocket)
      // If user provided a custom RPC_URL env var or --rpc-url flag, use it
      // Otherwise default to HTTP endpoint
      let rpcUrl = options.rpcUrl
      if (!rpcUrl || rpcUrl === RPC_URLS.calibration.websocket) {
        rpcUrl = RPC_URLS.calibration.http
      }

      // Create session key with progress logging
      const result = await createSessionKey({
        privateKey,
        validityDays,
        rpcUrl,
        warmStorageAddress: options.warmStorageAddress,
        onProgress: (step, details) => {
          console.log(picocolors.cyan(`${step}`))
          if (details && Object.keys(details).length > 0) {
            for (const [key, value] of Object.entries(details)) {
              console.log(picocolors.dim(`  ${key}: ${value}`))
            }
          }
        },
      })

      // Output formatted result
      console.log('')
      console.log(formatSessionKeyOutput(result))
    } catch (error) {
      console.error(picocolors.red('Session key creation failed:'), error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })

// Add auth options (for --private-key, --rpc-url)
addAuthOptions(createCommand)
sessionCommand.addCommand(createCommand)
