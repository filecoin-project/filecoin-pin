/**
 * Browser stub for ./devnet-config.js.
 *
 * Devnet support reads devnet-info.json from disk via node:fs/os/path, which has
 * no meaning in the browser. Bundlers resolve to this file via the "browser" field
 * in package.json, keeping node built-ins out of browser bundles. The only browser
 * path that reaches devnet config is a guarded probe in resolveChainFromRpc, which
 * catches this throw and falls through to the unsupported-chain error.
 */

import type { Chain } from '@filoz/synapse-sdk'

export interface DevnetConfig {
  chain: Chain
  privateKey: string | undefined
}

export function resolveDevnetConfig(): DevnetConfig {
  throw new Error('Devnet configuration is not available in the browser.')
}
