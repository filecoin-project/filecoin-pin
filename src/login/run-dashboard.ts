/**
 * Action handler for `filecoin-pin dashboard`: print and open the Filecoin
 * Cloud console billing page for the selected network.
 */

import pc from 'picocolors'
import { NETWORK_CHAINS, normalizeNetworkName } from '../common/get-rpc-url.js'
import { buildConsoleUrl, resolveConsoleUrl } from '../core/session/console-url.js'
import { log } from '../utils/cli-logger.js'
import { openBrowser } from './open-browser.js'

export interface DashboardOptions {
  network?: string | undefined
}

/**
 * Console billing page for the selected network (default mainnet). One
 * deployment serves mainnet and calibration, so both resolve to the same
 * page; `CONSOLE_URL` overrides. Throws when no console is known.
 */
export function resolveDashboardUrl(options: DashboardOptions): string {
  const network = normalizeNetworkName(options.network) ?? 'mainnet'
  const chain = NETWORK_CHAINS[network as keyof typeof NETWORK_CHAINS]
  const consoleUrl = chain === undefined ? process.env.CONSOLE_URL : resolveConsoleUrl(chain.id)
  if (consoleUrl === undefined) {
    throw new Error(`No Filecoin Cloud console is known for network "${network}". Set CONSOLE_URL to use one.`)
  }
  return buildConsoleUrl(consoleUrl)
}

export function runDashboard(options: DashboardOptions): void {
  const url = resolveDashboardUrl(options)
  log.line('  Opening the Filecoin Cloud console in your browser…')
  log.line(`  ${pc.cyan(pc.underline(url))}`)
  log.flush()
  openBrowser(url)
}
