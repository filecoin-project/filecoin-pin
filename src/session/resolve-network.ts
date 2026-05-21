/**
 * Resolve a {@link Chain}, RPC URL, and viem {@link Transport} from common CLI
 * options shared by all session subcommands.
 *
 * When only `--rpc-url` / `RPC_URL` is supplied, the chain is derived by
 * probing the endpoint's `eth_chainId`. The probe reuses the returned
 * transport so callers do not open a second WebSocket connection.
 */

import type { Transport } from 'viem'
import { getRpcUrl, NETWORK_CHAINS, resolveDevnetConfig } from '../common/get-rpc-url.js'
import { createTransport } from '../core/synapse/create-transport.js'
import type { Chain } from '../core/synapse/index.js'
import { resolveChainFromRpc } from '../core/synapse/resolve-chain-from-rpc.js'

export interface NetworkCliOptions {
  network?: string | undefined
  rpcUrl?: string | undefined
}

export interface ResolvedNetwork {
  chain: Chain
  rpcUrl: string
  transport: Transport
}

export async function resolveNetwork(options: NetworkCliOptions): Promise<ResolvedNetwork> {
  const network = options.network?.toLowerCase().trim()
  const rpcUrl = getRpcUrl(options)
  const transport = createTransport(rpcUrl)

  if (network === 'devnet') {
    return { chain: resolveDevnetConfig().chain, rpcUrl, transport }
  }
  if (network === 'calibration') {
    return { chain: NETWORK_CHAINS.calibration, rpcUrl, transport }
  }
  if (network === 'mainnet') {
    return { chain: NETWORK_CHAINS.mainnet, rpcUrl, transport }
  }

  // No explicit network. If the caller (or RPC_URL env) supplied an RPC URL,
  // probe it instead of silently defaulting to mainnet.
  if (options.rpcUrl) {
    return { chain: await resolveChainFromRpc(transport), rpcUrl, transport }
  }

  return { chain: NETWORK_CHAINS.mainnet, rpcUrl, transport }
}
