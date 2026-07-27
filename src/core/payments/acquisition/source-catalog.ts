import type { Address, PublicClient } from 'viem'
import { FILECOIN_NATIVE_TOKEN, SQUID_ROUTER } from './source-assets.js'

export const NATIVE_TOKEN_SELECTOR = 'native'
export const SQUID_CATALOG_TIMEOUT_MS = 5_000

export interface SelectedSourceChain {
  cliName: string
  chainId: number
  aliases: readonly string[]
  nativeSymbol: string
  nativeDecimals: number
}

/** The product boundary is fixed even though Squid's token catalog is dynamic. */
export const SELECTED_SOURCE_CHAINS = [
  { cliName: 'filecoin', chainId: 314, aliases: [], nativeSymbol: 'FIL', nativeDecimals: 18 },
  { cliName: 'arbitrum', chainId: 42161, aliases: ['arb'], nativeSymbol: 'ETH', nativeDecimals: 18 },
  { cliName: 'ethereum', chainId: 1, aliases: ['eth'], nativeSymbol: 'ETH', nativeDecimals: 18 },
  { cliName: 'base', chainId: 8453, aliases: [], nativeSymbol: 'ETH', nativeDecimals: 18 },
  { cliName: 'optimism', chainId: 10, aliases: ['op'], nativeSymbol: 'ETH', nativeDecimals: 18 },
  { cliName: 'polygon', chainId: 137, aliases: ['matic'], nativeSymbol: 'POL', nativeDecimals: 18 },
  { cliName: 'avalanche', chainId: 43114, aliases: ['avax'], nativeSymbol: 'AVAX', nativeDecimals: 18 },
  { cliName: 'bnb', chainId: 56, aliases: ['bsc'], nativeSymbol: 'BNB', nativeDecimals: 18 },
] as const satisfies readonly SelectedSourceChain[]

export interface ResolvedSourceToken {
  chain: SelectedSourceChain
  token: Address
  symbol: string
  decimals: number
  native: boolean
  /** Safe for confirmation/retry output; never an authorization primitive. */
  display: string
}

export interface SquidCatalog {
  chains: ReadonlyMap<number, { type: 'evm'; networkIdentifier: string; nativeSymbol: string; nativeDecimals: number }>
  tokens: readonly ResolvedSourceToken[]
}

interface SquidChainWire {
  chainId?: string | number
  networkName?: string
  type?: string
  nativeCurrency?: { symbol?: string; decimals?: number }
}

interface SquidTokenWire {
  chainId?: string | number
  symbol?: string
  address?: string
  decimals?: number
}

function fail(message: string): never {
  throw new Error(`Invalid Squid catalog: ${message}`)
}

function address(value: unknown, label: string): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) fail(`${label} must be an EVM address`)
  return value.toLowerCase() as Address
}

function selectedChain(input: string | undefined): SelectedSourceChain | undefined {
  const normalized = input?.trim().toLowerCase()
  return SELECTED_SOURCE_CHAINS.find(
    (chain) => chain.cliName === normalized || (chain.aliases as readonly string[]).includes(normalized ?? '')
  )
}

/** Parse only the selected EVM boundary and reject malformed selected entries. */
export function parseSquidCatalog(chainsResponse: unknown, tokensResponse: unknown): SquidCatalog {
  if (!Array.isArray(chainsResponse) || !Array.isArray(tokensResponse)) fail('chains and tokens must be arrays')
  const chains = new Map<
    number,
    { type: 'evm'; networkIdentifier: string; nativeSymbol: string; nativeDecimals: number }
  >()
  for (const raw of chainsResponse as SquidChainWire[]) {
    if (raw == null || typeof raw !== 'object') continue
    const id = typeof raw.chainId === 'string' && /^\d+$/.test(raw.chainId) ? Number(raw.chainId) : raw.chainId
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) continue
    const selected = SELECTED_SOURCE_CHAINS.find((chain) => chain.chainId === id)
    if (selected == null) continue
    if (raw.type !== 'evm') fail(`selected chain ${id} must be EVM`)
    if (typeof raw.networkName !== 'string' || raw.networkName.trim() === '') {
      fail(`selected chain ${id} is missing networkName`)
    }
    const nativeSymbol = raw.nativeCurrency?.symbol
    const nativeDecimals = raw.nativeCurrency?.decimals
    if (typeof nativeSymbol !== 'string' || nativeSymbol.trim() === '')
      fail(`selected chain ${id} is missing native symbol`)
    if (
      typeof nativeDecimals !== 'number' ||
      !Number.isSafeInteger(nativeDecimals) ||
      nativeDecimals < 0 ||
      nativeDecimals > 255
    ) {
      fail(`selected chain ${id} has invalid native decimals`)
    }
    if (nativeSymbol.trim() !== selected.nativeSymbol || nativeDecimals !== selected.nativeDecimals) {
      fail(`selected chain ${id} native currency conflicts with the trusted registry`)
    }
    if (chains.has(id)) fail(`selected chain ${id} is duplicated`)
    chains.set(id, {
      type: 'evm',
      networkIdentifier: raw.networkName,
      nativeSymbol: nativeSymbol.trim(),
      nativeDecimals,
    })
  }
  const tokens: ResolvedSourceToken[] = []
  const tokensByIdentity = new Map<string, ResolvedSourceToken>()
  for (const raw of tokensResponse as SquidTokenWire[]) {
    if (raw == null || typeof raw !== 'object') continue
    const id = typeof raw.chainId === 'string' && /^\d+$/.test(raw.chainId) ? Number(raw.chainId) : raw.chainId
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) continue
    const chain = SELECTED_SOURCE_CHAINS.find((candidate) => candidate.chainId === id)
    if (chain == null) continue
    if (!chains.has(id)) fail(`token belongs to unavailable selected chain ${id}`)
    if (typeof raw.symbol !== 'string' || raw.symbol.trim() === '') fail(`token on ${id} is missing symbol`)
    const decimals = raw.decimals
    if (typeof decimals !== 'number' || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
      fail(`token ${raw.symbol} on ${id} has invalid decimals`)
    }
    const token = address(raw.address, `token ${raw.symbol} on ${id}`)
    const native = token === FILECOIN_NATIVE_TOKEN
    const chainMetadata = chains.get(id)
    if (chainMetadata == null) fail(`token belongs to unavailable selected chain ${id}`)
    if (native && (raw.symbol.trim() !== chain.nativeSymbol || decimals !== chain.nativeDecimals)) {
      fail(`native token metadata conflicts with selected chain ${id}`)
    }
    const resolved = {
      chain,
      token,
      symbol: raw.symbol.trim(),
      decimals,
      native,
      display: native ? `${raw.symbol.trim()} (native)` : `${raw.symbol.trim()} (${token})`,
    }
    const identity = `${id}:${token}`
    const existing = tokensByIdentity.get(identity)
    if (existing != null) {
      if (
        existing.symbol !== resolved.symbol ||
        existing.decimals !== resolved.decimals ||
        existing.native !== resolved.native
      ) {
        fail(`token ${token} on ${id} is duplicated with conflicting metadata`)
      }
      continue
    }
    tokensByIdentity.set(identity, resolved)
    tokens.push(resolved)
  }
  return { chains, tokens }
}

/** Resolve a current catalog entry without using a symbol as an authorization decision. */
export function resolveCatalogSource(
  catalog: SquidCatalog,
  fromChain: string | undefined,
  fromToken: string | undefined
): ResolvedSourceToken {
  const chain = selectedChain(fromChain)
  if (chain == null) throw new Error(`Unsupported source chain: ${fromChain ?? '(missing)'}`)
  if (!catalog.chains.has(chain.chainId)) throw new Error(`Squid does not currently support ${chain.cliName}`)
  const selector = fromToken?.trim()
  if (selector == null || selector === '') throw new Error('A source token is required')
  const candidates = catalog.tokens.filter((token) => token.chain.chainId === chain.chainId)
  if (selector.toLowerCase() === NATIVE_TOKEN_SELECTOR) {
    const native = candidates.filter((token) => token.native)
    if (native.length !== 1) throw new Error(`Squid catalog has no unambiguous native token for ${chain.cliName}`)
    return native[0] as ResolvedSourceToken
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(selector)) {
    const exact = candidates.find((token) => token.token === selector.toLowerCase())
    if (exact == null) throw new Error(`Source token address is not supported on ${chain.cliName}`)
    return exact
  }
  const bySymbol = candidates.filter((token) => token.symbol.toLowerCase() === selector.toLowerCase())
  if (bySymbol.length === 1) return bySymbol[0] as ResolvedSourceToken
  if (bySymbol.length > 1) {
    throw new Error(
      `Source token symbol ${selector} is ambiguous on ${chain.cliName}; use one of: ${bySymbol.map((token) => token.token).join(', ')}`
    )
  }
  throw new Error(`Source token ${selector} is not supported on ${chain.cliName}`)
}

const erc20Identity = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const

/** Verify catalog display and amount fields against the selected ERC-20 before signing. */
export async function verifyResolvedErc20Source(
  client: Pick<PublicClient, 'getCode' | 'readContract'>,
  source: ResolvedSourceToken
): Promise<ResolvedSourceToken> {
  if (source.native) return source
  const code = await client.getCode({ address: source.token })
  if (code == null || code === '0x') throw new Error(`Source token ${source.token} has no contract code`)
  const [decimals, symbol] = await Promise.all([
    client.readContract({ address: source.token, abi: erc20Identity, functionName: 'decimals' }),
    client.readContract({ address: source.token, abi: erc20Identity, functionName: 'symbol' }),
  ])
  if (decimals !== source.decimals)
    throw new Error(`Source token decimals conflict with the Squid catalog for ${source.token}`)
  if (symbol !== source.symbol)
    throw new Error(`Source token symbol conflicts with the Squid catalog for ${source.token}`)
  return source
}

export interface SquidCatalogFetchOptions {
  integratorId: string | undefined
  fetchFn?: typeof fetch
  timeoutMs?: number
}

/** Fetches exactly the two acquisition-only catalog endpoints, with no cross-invocation cache. */
export async function fetchSquidCatalog(options: SquidCatalogFetchOptions): Promise<SquidCatalog> {
  if (options.integratorId == null || options.integratorId.trim() === '')
    throw new Error('Token acquisition requires SQUID_INTEGRATOR_ID')
  const timeout = options.timeoutMs ?? SQUID_CATALOG_TIMEOUT_MS
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('Squid catalog timeout must be positive')
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeout)
  const fetchFn = options.fetchFn ?? fetch
  try {
    const headers = { 'x-integrator-id': options.integratorId }
    const fetchCatalogEndpoint = async (url: string): Promise<Response> => {
      const response = await fetchFn(url, { headers, signal: controller.signal })
      if (!response.ok) throw new Error(`Squid catalog request failed (${response.status})`)
      return response
    }
    const [chains, tokens] = await Promise.all([
      fetchCatalogEndpoint('https://apiplus.squidrouter.com/v2/chains'),
      fetchCatalogEndpoint('https://apiplus.squidrouter.com/v2/tokens'),
    ])
    const [chainsBody, tokensBody] = await Promise.all([chains.json(), tokens.json()])
    if (
      chainsBody == null ||
      typeof chainsBody !== 'object' ||
      Array.isArray(chainsBody) ||
      !Array.isArray((chainsBody as { chains?: unknown }).chains)
    ) {
      fail('chains response must contain chains array')
    }
    if (
      tokensBody == null ||
      typeof tokensBody !== 'object' ||
      Array.isArray(tokensBody) ||
      !Array.isArray((tokensBody as { tokens?: unknown }).tokens)
    ) {
      fail('tokens response must contain tokens array')
    }
    return parseSquidCatalog((chainsBody as { chains: unknown[] }).chains, (tokensBody as { tokens: unknown[] }).tokens)
  } catch (error) {
    if (!controller.signal.aborted) controller.abort()
    if (timedOut) throw new Error('Squid catalog request timed out')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export interface TrustedRoutePolicy {
  chainId: number
  allowedTargets: readonly Address[]
  allowedSpenders: readonly Address[]
}

/**
 * Route targets and approval spenders are explicit deployment-policy inputs.
 * They deliberately do not derive from a catalog token, token symbol, or route display fields.
 */
export const TRUSTED_SQUID_ROUTE_POLICIES: readonly TrustedRoutePolicy[] = SELECTED_SOURCE_CHAINS.map((chain) => ({
  chainId: chain.chainId,
  allowedTargets: [SQUID_ROUTER.toLowerCase() as Address],
  allowedSpenders: [SQUID_ROUTER.toLowerCase() as Address],
}))

export function isTrustedSquidRouteAddress(chainId: number, value: string, kind: 'target' | 'spender'): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return false
  const policy = TRUSTED_SQUID_ROUTE_POLICIES.find((candidate) => candidate.chainId === chainId)
  return (
    policy?.[kind === 'target' ? 'allowedTargets' : 'allowedSpenders'].some(
      (address) => address === value.toLowerCase()
    ) ?? false
  )
}
