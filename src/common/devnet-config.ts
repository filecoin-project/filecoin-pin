/**
 * Devnet configuration loading.
 *
 * This module statically imports node:fs/os/path to read devnet-info.json, so it
 * is Node-only. Browser bundlers resolve it to ./devnet-config.browser.js via the
 * "browser" field in package.json — keeping node built-ins out of browser bundles.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { toChain, validateDevnetInfo } from '@filoz/synapse-core/devnet'
import type { Chain } from '@filoz/synapse-sdk'

function getDefaultDevnetInfoPath(): string {
  const baseDir = process.env.FOC_DEVNET_BASEDIR?.trim() || join(homedir(), '.foc-devnet')
  return join(baseDir, 'state', 'latest', 'devnet-info.json')
}

export interface DevnetConfig {
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
  if (user == null) {
    throw new Error(`DEVNET_USER_INDEX=${userIndex} did not resolve to a user in devnet-info.json`)
  }

  cachedDevnetConfig = {
    chain: toChain(devnetInfo),
    privateKey: user.private_key_hex,
  }
  return cachedDevnetConfig
}
