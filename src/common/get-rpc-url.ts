import { calibration, mainnet } from '@filoz/synapse-sdk'
import type { CLIAuthOptions } from '../utils/cli-auth.js'
import { DEVNET_CHAIN_ID } from './constants.js'
import { resolveDevnetConfig } from './devnet-config.js'

const NETWORK_CHAINS = {
  mainnet,
  calibration,
} as const

// Aliases accepted on input and rewritten to a canonical network name.
// Not surfaced in --help; the canonical names remain the documented choices.
const NETWORK_ALIASES: Record<string, string> = {
  calibnet: 'calibration',
}

/** Lowercase, trim, and apply NETWORK_ALIASES. Undefined for empty input. */
export function normalizeNetworkName(input: string | undefined): string | undefined {
  const trimmed = input?.toLowerCase().trim()
  if (!trimmed) return undefined
  return NETWORK_ALIASES[trimmed] ?? trimmed
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
 * 4. Default to mainnet
 */
export function getRpcUrl(options: CLIAuthOptions): string {
  if (options.rpcUrl) {
    return options.rpcUrl
  }

  const network = normalizeNetworkName(options.network)
  if (network) {
    if (network === 'devnet') {
      const devnet = resolveDevnetConfig()
      const rpcUrl = devnet.chain.rpcUrls.default.http[0]
      if (!rpcUrl) {
        throw new Error('No RPC URL available in devnet-info.json')
      }
      return rpcUrl
    }

    if (network !== 'mainnet' && network !== 'calibration') {
      throw new Error(`Invalid network: "${network}". Must be "mainnet", "calibration", or "devnet"`)
    }
    const chain = NETWORK_CHAINS[network]
    const wsUrl = chain.rpcUrls.default.webSocket?.[0]
    if (!wsUrl) {
      throw new Error(`WebSocket RPC URL not available for network: "${network}"`)
    }
    return wsUrl
  }

  const defaultUrl = mainnet.rpcUrls.default.webSocket?.[0] ?? mainnet.rpcUrls.default.http[0]
  if (!defaultUrl) {
    throw new Error('No RPC URL available for mainnet network')
  }
  return defaultUrl
}

export { DEVNET_CHAIN_ID, NETWORK_CHAINS, resolveDevnetConfig }
