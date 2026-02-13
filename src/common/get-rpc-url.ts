import { calibration, mainnet } from '@filoz/synapse-core/chains'
import type { CLIAuthOptions } from '../utils/cli-auth.js'

/** RPC URLs derived from chain config (synapse-core chains) */
export const RPC_URLS = {
  mainnet: {
    http: mainnet.rpcUrls.default.http[0],
    webSocket: mainnet.rpcUrls.default.webSocket?.[0] ?? mainnet.rpcUrls.default.http[0],
  },
  calibration: {
    http: calibration.rpcUrls.default.http[0],
    webSocket: calibration.rpcUrls.default.webSocket?.[0] ?? calibration.rpcUrls.default.http[0],
  },
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
    const rpcUrl = RPC_URLS[network as 'mainnet' | 'calibration']?.webSocket
    if (!rpcUrl) {
      throw new Error(`RPC URL not available for network: "${network}"`)
    }
    return rpcUrl
  }

  return RPC_URLS.calibration.webSocket ?? RPC_URLS.calibration.http ?? 'https://api.calibration.node.glif.io/rpc/v1'
}
