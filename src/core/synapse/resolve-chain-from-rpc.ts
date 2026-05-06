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

export async function resolveChainFromRpc(transport: Transport): Promise<Chain> {
  const client = createPublicClient({ transport })
  const id = await client.getChainId()

  if (id === mainnet.id) return mainnet
  if (id === calibration.id) return calibration

  // Devnet support pulls in node:fs via resolveDevnetConfig, so import it lazily to keep this
  // module browser-safe. Mainnet/calibration probes never reach this branch.
  try {
    const { resolveDevnetConfig } = await import('../../common/get-rpc-url.js')
    const devnet = resolveDevnetConfig().chain
    if (id === devnet.id) return devnet
  } catch {
    // devnet-info.json not available (or running in a browser bundle); fall through.
  }

  throw new Error(
    `Unsupported RPC chainId ${id}. Expected ${mainnet.id} (mainnet), ${calibration.id} (calibration), or a configured devnet chain id.`
  )
}
