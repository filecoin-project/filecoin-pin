import { type Chain, calibration, mainnet } from '@filoz/synapse-sdk'
import type { CLIAuthOptions } from '../utils/cli-auth.js'

const NETWORK_CHAINS = {
  mainnet,
  calibration,
} as const

type ConfiguredNetwork = keyof typeof NETWORK_CHAINS

function getConfiguredNetwork(options: CLIAuthOptions): ConfiguredNetwork | undefined {
  const network = (options.mainnet === true ? 'mainnet' : options.network)?.toLowerCase().trim()
  if (!network) {
    return undefined
  }
  if (network !== 'mainnet' && network !== 'calibration') {
    throw new Error(`Invalid network: "${network}". Must be "mainnet" or "calibration"`)
  }
  return network
}

export function getConfiguredChain(options: CLIAuthOptions): Chain | undefined {
  const network = getConfiguredNetwork(options)
  if (!network) {
    return undefined
  }
  return NETWORK_CHAINS[network]
}

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

  const network = getConfiguredNetwork(options)
  if (network) {
    const wsUrl = NETWORK_CHAINS[network].rpcUrls.default.webSocket?.[0]
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
