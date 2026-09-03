/**
 * Console URL helpers: the canonical builder for Filecoin Cloud console
 * deep links. Session-key pairing/login work builds on these same helpers.
 */

/**
 * One console deployment serves both networks and switches network in-app,
 * so the network travels in the `network` query parameter rather than in
 * the base URL. `CONSOLE_URL` overrides for local or preview consoles.
 */
export const DEFAULT_CONSOLE_URL = 'https://pay.filecoin.cloud'

/** Console base URL: `CONSOLE_URL` when set, otherwise the production deployment. */
export function resolveConsoleUrl(): string {
  return process.env.CONSOLE_URL ?? DEFAULT_CONSOLE_URL
}

/** Console network slug by chain id; the console validates and guards on it. */
const CONSOLE_NETWORK_SLUG: Record<number, string> = {
  314: 'mainnet',
  314159: 'calibration',
}

/**
 * Build the console deep link that pre-fills the session address and the
 * scopes it needs on the session-keys authorization page. Carries the
 * network the failure happened on so the console can refuse to prefill
 * when the connected wallet is on a different chain — without it, a
 * calibration remediation link approved by a mainnet-connected wallet
 * silently grants the scopes on mainnet.
 *
 * The address is lowercased: the console validates it with viem's strict
 * `isAddress`, which accepts all-lowercase or a correct EIP-55 checksum but
 * silently rejects mixed-case with a wrong checksum. Lowercase always passes.
 */
export function buildAuthorizeUrl(
  consoleUrl: string,
  sessionAddress: string,
  scopeIds: string[],
  chainId: number
): string {
  const base = consoleUrl.endsWith('/') ? consoleUrl.slice(0, -1) : consoleUrl
  const network = CONSOLE_NETWORK_SLUG[chainId]
  const networkParam = network ? `&network=${network}` : ''
  return `${base}/console/session-keys?authorize=${sessionAddress.toLowerCase()}&scopes=${scopeIds.join(',')}${networkParam}`
}
