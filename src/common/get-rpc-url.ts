import { calibration, mainnet } from '@filoz/synapse-sdk'
import type { CLIAuthOptions } from '../utils/cli-auth.js'

const NETWORK_CHAINS = {
  mainnet,
  calibration: calibration,
} as const

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
  if (options.rpcUrl) {
    return options.rpcUrl
  }

  // Try to use network flag
  const network = options.network?.toLowerCase().trim()
  if (network) {
    if (network !== 'mainnet' && network !== 'calibration') {
      throw new Error(`Invalid network: "${network}". Must be "mainnet" or "calibration"`)
    }
    const chain = NETWORK_CHAINS[network]
    const wsUrl = chain.rpcUrls.default.webSocket?.[0]
    if (!wsUrl) {
      throw new Error(`WebSocket RPC URL not available for network: "${network}"`)
    }
    return wsUrl
  }

  const defaultUrl = calibration.rpcUrls.default.webSocket?.[0] ?? calibration.rpcUrls.default.http[0]
  if (!defaultUrl) {
    throw new Error('No RPC URL available for calibration network')
  }
  return defaultUrl
}
