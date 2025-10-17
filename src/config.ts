import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { RPC_URLS } from '@filoz/synapse-sdk'
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
 * This demonstrates configuration best practices for Synapse SDK:
 * - PRIVATE_KEY: Required for transaction signing (keep secure!)
 * - RPC_URL: Filecoin network endpoint (mainnet or calibration)
 * - WARM_STORAGE_ADDRESS: Optional override for testing custom contracts
 */
export function createConfig(): Config {
  const dataDir = getDataDirectory()

  return {
    // Application-specific configuration
    port: parseInt(process.env.PORT ?? '3456', 10),
    host: process.env.HOST ?? 'localhost',

    // Synapse SDK configuration
    privateKey: process.env.PRIVATE_KEY, // Required: Ethereum-compatible private key
    rpcUrl: process.env.RPC_URL ?? RPC_URLS.calibration.websocket, // Default: calibration testnet websocket
    warmStorageAddress: process.env.WARM_STORAGE_ADDRESS, // Optional: custom contract address

    // Storage paths
    databasePath: process.env.DATABASE_PATH ?? join(dataDir, 'pins.db'),
    carStoragePath: process.env.CAR_STORAGE_PATH ?? join(dataDir, 'cars'),

    // Logging
    logLevel: process.env.LOG_LEVEL ?? 'info',
  }
}
