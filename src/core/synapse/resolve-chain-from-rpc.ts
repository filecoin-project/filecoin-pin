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
import type { Logger } from 'pino'
import { createPublicClient, type Transport } from 'viem'

export async function resolveChainFromRpc(transport: Transport, logger?: Logger): Promise<Chain> {
  const client = createPublicClient({ transport })
  logger?.debug('probing RPC chainId')
  const start = Date.now()
  const id = await client.getChainId()
  const durationMs = Date.now() - start
  logger?.debug({ chainId: id, durationMs }, 'resolved RPC chainId')

  if (id === mainnet.id) return mainnet
  if (id === calibration.id) return calibration

  // Devnet support pulls in node:fs via resolveDevnetConfig, so import it lazily to keep this
  // module browser-safe. Browser bundlers resolve devnet-config to a stub (see the "browser"
  // field in package.json). Mainnet/calibration probes never reach this branch.
  try {
    const { resolveDevnetConfig } = await import('../../common/devnet-config.js')
    const devnet = resolveDevnetConfig().chain
    if (id === devnet.id) return devnet
  } catch (err) {
    logger?.debug({ err }, 'devnet config unavailable, skipping')
  }

  throw new Error(
    `Unsupported RPC chainId ${id}. Expected ${mainnet.id} (mainnet), ${calibration.id} (calibration), or a configured devnet chain id.`
  )
}
