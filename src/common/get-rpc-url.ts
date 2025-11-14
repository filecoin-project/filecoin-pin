import { RPC_URLS } from '@filoz/synapse-sdk'
import type { CLIAuthOptions } from '../utils/cli-auth.js'

/**
 * Get the RPC URL from the CLI options.
 *
 * This should only be called from commands using commander, so ENV vars are already handled.
 *
 * Network selection priority:
 * 1. Explicit --rpc-url (highest priority)
 * 2. RPC_URL environment variable
 * 3. --network flag or NETWORK environment variable (converted to RPC URL)
 * 4. Default to calibration
 */
export function getRpcUrl(options: CLIAuthOptions): string {
  // Determine RPC URL with priority: explicit rpcUrl > RPC_URL env > network flag/env > default
  let rpcUrl: string | undefined
  if (options.rpcUrl) {
    // Explicit RPC URL takes highest priority
    return options.rpcUrl
  }

  // Try to use network flag
  const network = options.network?.toLowerCase().trim()
  if (network) {
    // Validate network value
    if (network !== 'mainnet' && network !== 'calibration') {
      throw new Error(`Invalid network: "${network}". Must be "mainnet" or "calibration"`)
    }
    // Convert network to RPC URL
    rpcUrl = RPC_URLS[network as 'mainnet' | 'calibration']?.websocket
    if (!rpcUrl) {
      throw new Error(`RPC URL not available for network: "${network}"`)
    }
    return rpcUrl
  }

  return RPC_URLS.calibration.websocket
}
