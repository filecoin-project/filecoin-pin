import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import type { Chain } from '@filoz/synapse-sdk'
import { getRpcUrl, NETWORK_CHAINS, normalizeNetworkName, resolveDevnetConfig } from './common/get-rpc-url.js'
import type { Config } from './core/synapse/index.js'

function resolveChain(network: string | undefined, hasExplicitRpcUrl: boolean): Chain | undefined {
  const normalized = normalizeNetworkName(network)
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

  // NETWORK and RPC_URL are mutually exclusive. The CLI enforces this via Commander, but library
  // consumers calling createConfig() bypass that check, so guard explicitly here as well.
  const hasNetwork = process.env.NETWORK != null && process.env.NETWORK !== ''
  const hasRpcUrl = process.env.RPC_URL != null && process.env.RPC_URL !== ''
  if (hasNetwork && hasRpcUrl) {
    throw new Error("Configuration error: 'NETWORK' and 'RPC_URL' are mutually exclusive. Set only one.")
  }

  // Determine RPC URL: RPC_URL takes precedence, then NETWORK, then default to mainnet.
  const rpcUrl = getRpcUrl({
    network: process.env.NETWORK,
    rpcUrl: process.env.RPC_URL,
  })
  // Set the chain hint only when NETWORK was chosen; with RPC_URL set, initializeSynapse probes
  // the endpoint to derive the chain. Default to mainnet when neither is supplied.
  const chain = hasRpcUrl ? resolveChain(undefined, true) : resolveChain(process.env.NETWORK ?? 'mainnet', false)

  // Treat an empty PORT/HOST (e.g. docker-compose interpolation of an unset
  // variable) the same as unset, and reject non-numeric or out-of-range ports
  // with a clear error instead of letting NaN reach the listener.
  const port = parseInt(process.env.PORT || '3000', 10)
  if (Number.isNaN(port) || port < 0 || port > 65535) {
    throw new Error(`Configuration error: PORT must be a number between 0 and 65535, got '${process.env.PORT}'`)
  }

  const config: Config = {
    // Application-specific configuration
    port,
    host: process.env.HOST || '127.0.0.1',
    accessToken: process.env.ACCESS_TOKEN,
    allowNoAuth: process.env.ALLOW_NO_AUTH === 'true',

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
