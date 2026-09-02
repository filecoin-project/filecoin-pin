/**
 * Console URL helpers: the canonical builder for Filecoin Cloud console
 * deep links. Session-key pairing/login work builds on these same helpers.
 */

/**
 * Console deployments by chain id. One deployment serves both networks and
 * the console switches network in-app, so mainnet and calibration share a
 * base URL; the network travels in the `network` query parameter.
 * `CONSOLE_URL` still overrides for local or preview consoles.
 */
export const DEFAULT_CONSOLE_URLS: Record<number, string> = {
  314: 'https://pay.filecoin.cloud',
  314159: 'https://pay.filecoin.cloud',
}

/**
 * Pick the console base URL: `CONSOLE_URL` wins, then the known deployment
 * for the chain. Returns `undefined` when neither resolves — the caller
 * falls back to a console-without-a-link message.
 */
export function resolveConsoleUrl(chainId: number): string | undefined {
  return process.env.CONSOLE_URL ?? DEFAULT_CONSOLE_URLS[chainId]
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
  chainId?: number
): string {
  const base = consoleUrl.endsWith('/') ? consoleUrl.slice(0, -1) : consoleUrl
  const network = chainId != null ? CONSOLE_NETWORK_SLUG[chainId] : undefined
  const networkParam = network ? `&network=${network}` : ''
  return `${base}/console/session-keys?authorize=${sessionAddress.toLowerCase()}&scopes=${scopeIds.join(',')}${networkParam}`
}
