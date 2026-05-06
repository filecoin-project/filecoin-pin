/**
 * Probe an RPC endpoint's chainId and resolve the matching Chain.
 *
 * Filecoin chain id mapping:
 *   314      → mainnet
 *   314159   → calibration
 *   devnet   → chain from devnet-info.json (if available)
 *
 * Throws when the chainId does not match any known chain.
 */
import { type Chain, calibration, mainnet } from '@filoz/synapse-sdk'
import { createPublicClient, type Transport } from 'viem'
import { resolveDevnetConfig } from '../../common/get-rpc-url.js'

export async function resolveChainFromRpc(transport: Transport): Promise<Chain> {
  const client = createPublicClient({ transport })
  const id = await client.getChainId()

  if (id === mainnet.id) return mainnet
  if (id === calibration.id) return calibration

  try {
    const devnet = resolveDevnetConfig().chain
    if (id === devnet.id) return devnet
  } catch {
    // devnet-info.json not available; fall through to unknown-chain error
  }

  throw new Error(
    `Unsupported RPC chainId ${id}. Expected ${mainnet.id} (mainnet), ${calibration.id} (calibration), or a configured devnet chain id.`
  )
}
