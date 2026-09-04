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
  const base = trimSlash(consoleUrl)
  return `${base}/console/session-keys?authorize=${sessionAddress.toLowerCase()}&scopes=${scopeIds.join(',')}${networkParam(chainId)}`
}

/** `&network=<slug>` for a chain the console knows, empty otherwise: the console refuses a link it cannot place. */
function networkParam(chainId: number): string {
  const network = CONSOLE_NETWORK_SLUG[chainId]
  return network ? `&network=${network}` : ''
}

/** Deposit the CLI suggests when the account has no funds yet, in whole USDFC. */
export const DEFAULT_SUGGESTED_DEPOSIT_USDFC = 2

function trimSlash(consoleUrl: string): string {
  return consoleUrl.endsWith('/') ? consoleUrl.slice(0, -1) : consoleUrl
}

/** The console home (billing) page. */
export function buildConsoleUrl(consoleUrl: string): string {
  return `${trimSlash(consoleUrl)}/console`
}

/**
 * Funding deep link: the console pre-fills a deposit-and-approve dialog
 * for the storage service with `deposit` whole USDFC, so topping up and
 * approving the service is one wallet transaction. Carries the network so
 * the console refuses to prefill a deposit for a wallet on another chain.
 */
export function buildFundingUrl(consoleUrl: string, depositUsdfc: number, chainId: number): string {
  return `${trimSlash(consoleUrl)}/console?deposit=${depositUsdfc}&operator=fwss${networkParam(chainId)}`
}
