/**
 * Action handler for `filecoin-pin dashboard`: print and open the Filecoin
 * Cloud console billing page.
 */

import pc from 'picocolors'
import { buildConsoleUrl, resolveConsoleUrl } from '../core/session/console-url.js'
import { log } from '../utils/cli-logger.js'
import { openBrowser } from './open-browser.js'

/**
 * Console billing page. One deployment serves mainnet and calibration, so
 * every network resolves to the same page; `CONSOLE_URL` overrides.
 */
export function resolveDashboardUrl(): string {
  return buildConsoleUrl(resolveConsoleUrl())
}

export function runDashboard(): void {
  const url = resolveDashboardUrl()
  log.line(`  ${pc.cyan(pc.underline(url))}`)
  // Only a terminal gets a browser; an agent or CI run gets the URL alone.
  log.line(
    openBrowser(url)
      ? '  Opening the Filecoin Cloud console in your browser…'
      : '  Open the Filecoin Cloud console at the URL above.'
  )
  log.flush()
}
