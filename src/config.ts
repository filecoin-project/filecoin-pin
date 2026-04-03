import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { getRpcUrl } from './common/get-rpc-url.js'
import type { Config } from './core/synapse/index.js'

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

  // Determine RPC URL: RPC_URL env var takes precedence, then NETWORK, then default to calibration
  const rpcUrl = getRpcUrl({
    network: process.env.NETWORK,
    rpcUrl: process.env.RPC_URL,
  })

  return {
    // Application-specific configuration
    port: parseInt(process.env.PORT ?? '3456', 10),
    host: process.env.HOST ?? 'localhost',
    accessToken: process.env.ACCESS_TOKEN,

    // Synapse SDK configuration
    privateKey: process.env.PRIVATE_KEY,
    walletAddress: process.env.WALLET_ADDRESS,
    sessionKey: process.env.SESSION_KEY,
    rpcUrl, // Determined from RPC_URL, NETWORK, or default to calibration
    // Storage paths
    databasePath: process.env.DATABASE_PATH ?? join(dataDir, 'pins.db'),
    carStoragePath: process.env.CAR_STORAGE_PATH ?? join(dataDir, 'cars'),

    // Logging
    logLevel: process.env.LOG_LEVEL ?? 'info',
  }
}
