/**
 * Action handler for `filecoin-pin dashboard`: print and open the Filecoin
 * Cloud console billing page.
 */

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

export interface DashboardOptions {
  /** False (`--no-browser`) prints the link without opening it. */
  browser?: boolean | undefined
}

export function runDashboard(options: DashboardOptions = {}): void {
  const url = resolveDashboardUrl()
  // The link on its own line, unstyled, so it copies and parses cleanly.
  log.line(url)
  // Only a terminal gets a browser; an agent, a CI run, or --no-browser gets the URL alone.
  log.line(
    options.browser !== false && openBrowser(url)
      ? '  Opening the Filecoin Cloud console in your browser…'
      : '  Open the Filecoin Cloud console at the URL above.'
  )
  log.flush()
}
