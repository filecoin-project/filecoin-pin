/**
 * Console URL helper for session-key preflight remediation messages.
 *
 * TEMPORARY: dedupe with the session console-pairing helpers
 * (resolveConsoleUrl/buildAuthorizeUrl) when that work lands on master.
 */

/**
 * Known console deployments by chain id. One deployment serves both networks
 * (the console switches network in-app), so mainnet and calibration share a
 * base URL. `CONSOLE_URL` still overrides for local/preview consoles.
 *
 * NOTE: links 404 until the console's session-keys page (with its
 * ?authorize=&scopes= pairing params) is deployed — this PR is opened
 * together with that console PR and must not ship ahead of it.
 */
export const DEFAULT_CONSOLE_URLS: Record<number, string> = {
  314: 'https://pay.filecoin.cloud',
  314159: 'https://pay.filecoin.cloud',
}

/**
 * Pick the console base URL: an explicit override wins, then `CONSOLE_URL`,
 * then the known deployment for the chain. Returns `undefined` when none of
 * those resolve — the caller falls back to a console-without-a-link message.
 */
export function resolveConsoleUrl(chainId: number, override?: string): string | undefined {
  return override ?? process.env.CONSOLE_URL ?? DEFAULT_CONSOLE_URLS[chainId]
}

/**
 * Build the console deep link that pre-fills the session address and the
 * scopes it needs on the session-keys authorization page.
 */
export function buildAuthorizeUrl(consoleUrl: string, sessionAddress: string, scopeIds: string[]): string {
  const base = consoleUrl.endsWith('/') ? consoleUrl.slice(0, -1) : consoleUrl
  return `${base}/console/session-keys?authorize=${sessionAddress}&scopes=${scopeIds.join(',')}`
}
