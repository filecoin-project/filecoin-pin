import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import type { Chain } from '@filoz/synapse-sdk'
import { getRpcUrl, NETWORK_CHAINS, resolveDevnetConfig } from './common/get-rpc-url.js'
import type { Config } from './core/synapse/index.js'

function resolveChain(network: string | undefined, hasExplicitRpcUrl: boolean): Chain | undefined {
  const normalized = network?.toLowerCase().trim()
  if (!normalized) return undefined
  if (normalized === 'mainnet' || normalized === 'calibration') return NETWORK_CHAINS[normalized]
  // Devnet's chain comes from devnet-info.json. Skip the file load when the operator
  // overrode RPC_URL — they may just have a stale NETWORK=devnet and the file may not exist.
  if (normalized === 'devnet' && !hasExplicitRpcUrl) return resolveDevnetConfig().chain
  return undefined
}

function getDataDirectory(): string {
  const home = homedir()
  const plat = platform()

  // Follow XDG Base Directory Specification on Linux
  if (plat === 'linux') {
    return process.env.XDG_DATA_HOME ?? join(home, '.local', 'share', 'filecoin-pin')
  }

  // macOS uses ~/Library/Application Support (same as config)
  if (plat === 'darwin') {
    return join(home, 'Library', 'Application Support', 'filecoin-pin')
  }

  // Windows uses %APPDATA%
  if (plat === 'win32') {
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'filecoin-pin')
  }

  // Fallback for other platforms
  return join(home, '.filecoin-pin')
}

/**
 * Create configuration from environment variables
 *
 * Authentication (choose one):
 * - PRIVATE_KEY: Standard private key auth
 * - WALLET_ADDRESS + SESSION_KEY: Session key auth
 *
 * Network:
 * - RPC_URL: Filecoin RPC endpoint — takes precedence over NETWORK
 * - NETWORK: Filecoin network name (mainnet, calibration, devnet) — used if RPC_URL not set
 */
export function createConfig(): Config {
  const dataDir = getDataDirectory()

  // Determine RPC URL: RPC_URL env var takes precedence, then NETWORK, then default to mainnet
  const rpcUrl = getRpcUrl({
    network: process.env.NETWORK,
    rpcUrl: process.env.RPC_URL,
  })
  // Chain selection mirrors parseCLIAuth:
  //  - NETWORK explicit → set chain so initializeSynapse can verify against the RPC probe.
  //  - RPC_URL set without NETWORK → leave chain undefined; probe derives it.
  //  - Neither set → default to mainnet, mirroring getRpcUrl's URL default.
  const hasRpcUrl = process.env.RPC_URL != null && process.env.RPC_URL !== ''
  const chain = resolveChain(process.env.NETWORK ?? (hasRpcUrl ? undefined : 'mainnet'), hasRpcUrl)

  const config: Config = {
    // Application-specific configuration
    port: parseInt(process.env.PORT ?? '3456', 10),
    host: process.env.HOST ?? 'localhost',
    accessToken: process.env.ACCESS_TOKEN,

    // Synapse SDK configuration
    privateKey: process.env.PRIVATE_KEY,
    walletAddress: process.env.WALLET_ADDRESS,
    sessionKey: process.env.SESSION_KEY,
    rpcUrl, // Determined from RPC_URL, NETWORK, or default to mainnet
    // Storage paths
    databasePath: process.env.DATABASE_PATH ?? join(dataDir, 'pins.db'),
    carStoragePath: process.env.CAR_STORAGE_PATH ?? join(dataDir, 'cars'),

    // Logging
    logLevel: process.env.LOG_LEVEL ?? 'info',
  }
  if (chain) {
    config.chain = chain
  }
  return config
}
