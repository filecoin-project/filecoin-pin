import { RPC_URLS } from '@filoz/synapse-sdk'
import { CLIAuthOptions } from '../utils/cli-auth.js'

/**
 * Get the RPC URL from the CLI options and environment variables
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
  if (options.rpcUrl || process.env.RPC_URL) {
    // Explicit RPC URL takes highest priority
    rpcUrl = options.rpcUrl || process.env.RPC_URL
  }
  if (!rpcUrl) {
    // Try to use network flag/env var
    const network = (options.network || process.env.NETWORK)?.toLowerCase().trim()
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
  }

  return RPC_URLS.calibration.websocket
}
