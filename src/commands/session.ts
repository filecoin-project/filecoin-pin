/**
 * Session key management commands
 *
 * This module provides CLI commands for creating and managing session keys
 * that allow delegated access to Synapse SDK without exposing the main private key.
 */

import { Command } from 'commander'
import picocolors from 'picocolors'
import type { Hex } from 'viem'
import { getRpcUrl, NETWORK_CHAINS, resolveDevnetConfig } from '../common/get-rpc-url.js'
import { createSessionKey, formatSessionKeyOutput } from '../core/session/create-session-key.js'
import type { Chain } from '../core/synapse/index.js'
import { addAuthOptions } from '../utils/cli-options.js'

export const sessionCommand = new Command('session').description(
  'Manage session keys for delegated access to Synapse SDK'
)

const createCommand = new Command('create')
  .description('Create and authorize a new session key')
  .option('--validity-days <days>', 'Number of days the session key should be valid', '10')
  .option('--session-private-key <key>', 'Private key for the session wallet (can also use SESSION_PRIVATE_KEY env)')
  .action(async (options) => {
    try {
      const privateKey = options.privateKey || process.env.PRIVATE_KEY
      if (!privateKey) {
        console.error(picocolors.red('Error: PRIVATE_KEY environment variable or --private-key option is required'))
        process.exit(1)
      }

      const sessionPrivateKey = options.sessionPrivateKey || process.env.SESSION_PRIVATE_KEY

      const validityDays = Number.parseInt(options.validityDays, 10)
      if (Number.isNaN(validityDays) || validityDays <= 0) {
        console.error(picocolors.red(`Error: Invalid validity days: ${options.validityDays}`))
        process.exit(1)
      }

      const network = options.network?.toLowerCase().trim()
      let chain: Chain
      if (network === 'devnet') {
        chain = resolveDevnetConfig().chain
      } else if (network === 'calibration') {
        chain = NETWORK_CHAINS.calibration
      } else if (network === 'mainnet') {
        chain = NETWORK_CHAINS.mainnet
      } else {
        chain = NETWORK_CHAINS.mainnet
      }
      const rpcUrl = getRpcUrl(options)

      const result = await createSessionKey({
        privateKey: privateKey as Hex,
        ...(sessionPrivateKey ? { sessionPrivateKey: sessionPrivateKey as Hex } : {}),
        validityDays,
        chain,
        rpcUrl,
        onProgress: (step, details) => {
          console.log(picocolors.cyan(`${step}`))
          if (details && Object.keys(details).length > 0) {
            for (const [key, value] of Object.entries(details)) {
              console.log(picocolors.dim(`  ${key}: ${value}`))
            }
          }
        },
      })

      console.log('')
      console.log(formatSessionKeyOutput(result))
    } catch (error) {
      console.error(picocolors.red('Session key creation failed:'), error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })

addAuthOptions(createCommand)
sessionCommand.addCommand(createCommand)
