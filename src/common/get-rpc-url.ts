import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { toChain, validateDevnetInfo } from '@filoz/synapse-core/devnet'
import type { Chain } from '@filoz/synapse-sdk'
import { calibration, mainnet } from '@filoz/synapse-sdk'
import type { CLIAuthOptions } from '../utils/cli-auth.js'

const NETWORK_CHAINS = {
  mainnet,
  calibration,
} as const

const DEVNET_CHAIN_ID = 31415926
function getDefaultDevnetInfoPath(): string {
  const baseDir = process.env.FOC_DEVNET_BASEDIR?.trim() || join(homedir(), '.foc-devnet')
  return join(baseDir, 'state', 'latest', 'devnet-info.json')
}

interface DevnetConfig {
  chain: Chain
  privateKey: string | undefined
}

let cachedDevnetConfig: DevnetConfig | undefined

/**
 * Load and cache devnet configuration from devnet-info.json.
 *
 * Reads the devnet info file, validates it, and builds a Chain via synapse-core's
 * toChain(). The result is cached for the lifetime of the process so that
 * getRpcUrl() and parseCLIAuth() share the same chain object.
 */
export function resolveDevnetConfig(): DevnetConfig {
  if (cachedDevnetConfig) {
    return cachedDevnetConfig
  }

  const devnetInfoPath = process.env.DEVNET_INFO_PATH || getDefaultDevnetInfoPath()
  const userIndex = Number(process.env.DEVNET_USER_INDEX || '0')

  let rawData: unknown
  try {
    rawData = JSON.parse(readFileSync(devnetInfoPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `Failed to read devnet info from ${devnetInfoPath}: ${error instanceof Error ? error.message : String(error)}. ` +
        'Set DEVNET_INFO_PATH to the correct path, or ensure foc-devnet is running.'
    )
  }

  const devnetInfo = validateDevnetInfo(rawData)
  const { info } = devnetInfo

  if (userIndex >= info.users.length) {
    throw new Error(
      `DEVNET_USER_INDEX=${userIndex} out of range (${info.users.length} user(s) available in devnet-info.json)`
    )
  }

  const user = info.users[userIndex]

  cachedDevnetConfig = {
    chain: toChain(devnetInfo),
    privateKey: user?.private_key_hex,
  }
  return cachedDevnetConfig
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
 * 4. Default to calibration
 */
export function getRpcUrl(options: CLIAuthOptions): string {
  if (options.rpcUrl) {
    return options.rpcUrl
  }

  const network = options.network?.toLowerCase().trim()
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

  const defaultUrl = calibration.rpcUrls.default.webSocket?.[0] ?? calibration.rpcUrls.default.http[0]
  if (!defaultUrl) {
    throw new Error('No RPC URL available for calibration network')
  }
  return defaultUrl
}

export { DEVNET_CHAIN_ID, NETWORK_CHAINS }
