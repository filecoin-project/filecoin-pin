/**
 * Resolve a {@link Chain} + RPC URL from common CLI options shared by all
 * session subcommands.
 */

import { getRpcUrl, NETWORK_CHAINS, resolveDevnetConfig } from '../common/get-rpc-url.js'
import type { Chain } from '../core/synapse/index.js'

export interface NetworkCliOptions {
  network?: string | undefined
  rpcUrl?: string | undefined
}

export function resolveNetwork(options: NetworkCliOptions): { chain: Chain; rpcUrl: string } {
  const network = options.network?.toLowerCase().trim()
  let chain: Chain
  if (network === 'devnet') {
    chain = resolveDevnetConfig().chain
  } else if (network === 'calibration') {
    chain = NETWORK_CHAINS.calibration
  } else {
    chain = NETWORK_CHAINS.mainnet
  }
  const rpcUrl = getRpcUrl(options)
  return { chain, rpcUrl }
}
