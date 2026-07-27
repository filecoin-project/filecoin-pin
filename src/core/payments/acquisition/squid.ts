import type { Address } from 'viem'
import { FILECOIN_MAINNET_CHAIN_ID, FILECOIN_NATIVE_TOKEN, FILECOIN_USDFC, SQUID_ROUTER } from './source-assets.js'
import type {
  AcquisitionErrorCode,
  AcquisitionExecutionStatus,
  AcquisitionLeg,
  PlannedAcquisitionQuote,
} from './types.js'

export const SQUID_API_URL = 'https://apiplus.squidrouter.com/v2'
export const MIN_SQUID_SLIPPAGE_PERCENT = 0.01
export const MAX_SQUID_SLIPPAGE_PERCENT = 99.99
const MAX_RATE_LIMIT_RETRIES = 1
const MAX_ESTIMATED_ROUTE_DURATION_SECONDS = 30 * 60

export interface SquidRouteRequest {
  fromAddress: Address
  sourceAmount: bigint
  leg: AcquisitionLeg
  slippage: number
}

interface SquidRouteResponse {
  route?: {
    quoteId?: string
    params?: Record<string, unknown>
    estimate?: { toAmountMin?: string; estimatedRouteDuration?: number }
    transactionRequest?: {
      target?: string
      data?: string
      value?: string
      gasLimit?: string
      maxFeePerGas?: string
      expiry?: string
      requestId?: string
    }
  }
}

export interface SquidProviderOptions {
  integratorId: string | undefined
  fetchFn?: typeof fetch
  now?: () => number
}

export interface SquidStatusResponse {
  squidTransactionStatus?: string
  id?: string
  axelarTransactionUrl?: string
  fromChain?: { transactionId?: string; transactionUrl?: string }
  toChain?: { transactionId?: string; transactionUrl?: string }
}

export interface SquidStatusRequest {
  transactionId: string
  fromChainId: string
  toChainId: string
  quoteId: string
  requestId?: string
}

export interface SquidStatusResult {
  status: AcquisitionExecutionStatus
  errorCode?: AcquisitionErrorCode
  sourceTransactionUrl?: string
  destinationTransactionHash?: string
  destinationTransactionUrl?: string
  providerExplorerUrl?: string
}

/** Squid accepts inclusive percentage slippage in this provider-defined range. */
export function isSupportedSquidSlippage(value: number): boolean {
  return Number.isFinite(value) && value >= MIN_SQUID_SLIPPAGE_PERCENT && value <= MAX_SQUID_SLIPPAGE_PERCENT
}

function providerError(message: string, code: AcquisitionErrorCode = 'quote-failed'): Error {
  const error = new Error(message)
  error.name = code
  return error
}

function destinationToken(asset: AcquisitionLeg['asset']): string {
  return asset === 'fil' ? FILECOIN_NATIVE_TOKEN : FILECOIN_USDFC
}

/** EVM address equality is case-insensitive, but malformed provider values never pass validation. */
function equalEvmAddresses(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(actual) || !/^0x[0-9a-fA-F]{40}$/.test(expected)) {
    return false
  }
  return actual.toLowerCase() === expected.toLowerCase()
}

function asPositiveBigInt(value: string | undefined, label: string): bigint {
  if (value == null || !/^\d+$/.test(value)) throw providerError(`Squid route is missing ${label}`)
  return BigInt(value)
}

async function squidFetch(url: string, init: RequestInit, fetchFn: typeof fetch): Promise<Response> {
  let rateLimitRetries = 0
  while (true) {
    const response = await fetchFn(url, init)
    if (response.status !== 429 || rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) return response
    rateLimitRetries += 1
    const retryAfter = Number(response.headers.get('retry-after') ?? '0')
    if (!Number.isFinite(retryAfter) || retryAfter < 0 || retryAfter > 5) return response
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000))
  }
}

/** Fetch and strictly validate a current Squid route before any signature. */
export async function getSquidRoute(
  request: SquidRouteRequest,
  options: SquidProviderOptions
): Promise<PlannedAcquisitionQuote> {
  if (!isSupportedSquidSlippage(request.slippage)) {
    throw providerError(
      `Squid slippage must be between ${MIN_SQUID_SLIPPAGE_PERCENT} and ${MAX_SQUID_SLIPPAGE_PERCENT} percent`
    )
  }
  if (!options.integratorId) throw providerError('Token acquisition requires SQUID_INTEGRATOR_ID')
  if (request.leg.source?.chainId !== 42161 || request.leg.source.symbol !== 'USDC') {
    throw providerError('Only Arbitrum USDC is supported for token acquisition', 'unsupported-source')
  }
  const fetchFn = options.fetchFn ?? fetch
  const body = {
    fromAddress: request.fromAddress,
    toAddress: request.fromAddress,
    fromChain: '42161',
    fromToken: request.leg.source.token,
    fromAmount: request.sourceAmount.toString(),
    toChain: String(FILECOIN_MAINNET_CHAIN_ID),
    toToken: destinationToken(request.leg.asset),
    slippage: request.slippage,
    quoteOnly: false,
  }
  const response = await squidFetch(
    `${SQUID_API_URL}/route`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-integrator-id': options.integratorId },
      body: JSON.stringify(body),
    },
    fetchFn
  )
  if (!response.ok) throw providerError(`Squid quote failed (${response.status})`)
  const parsed = (await response.json()) as SquidRouteResponse
  const route = parsed.route
  const transaction = route?.transactionRequest
  const params = route?.params
  if (
    route?.quoteId == null ||
    transaction == null ||
    params == null ||
    transaction.target == null ||
    !equalEvmAddresses(transaction.target, SQUID_ROUTER)
  ) {
    throw providerError('Squid route failed the approved-target validation')
  }
  if (
    params.fromChain !== '42161' ||
    params.fromAmount !== request.sourceAmount.toString() ||
    params.toChain !== String(FILECOIN_MAINNET_CHAIN_ID) ||
    !equalEvmAddresses(params.fromToken, request.leg.source.token) ||
    !equalEvmAddresses(params.toToken, destinationToken(request.leg.asset)) ||
    !equalEvmAddresses(params.fromAddress, request.fromAddress) ||
    !equalEvmAddresses(params.toAddress, request.fromAddress)
  ) {
    throw providerError('Squid route failed the approved-asset validation')
  }
  const expiresAt = Number(transaction.expiry)
  const now = Math.floor((options.now ?? Date.now)() / 1000)
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw providerError('Squid returned an expired route')
  const data = transaction.data
  if (data == null || data === '0x') throw providerError('Squid route has no calldata')
  return {
    id: route.quoteId,
    asset: request.leg.asset,
    sourceAmount: request.sourceAmount,
    destinationAmount: asPositiveBigInt(route.estimate?.toAmountMin, 'minimum destination amount'),
    target: transaction.target,
    data,
    value: asPositiveBigInt(transaction.value ?? '0', 'transaction value'),
    gasLimit: asPositiveBigInt(transaction.gasLimit, 'gas limit'),
    maxFeePerGas: asPositiveBigInt(transaction.maxFeePerGas, 'maximum fee per gas'),
    expiresAt,
    estimatedRouteDurationSeconds:
      typeof route.estimate?.estimatedRouteDuration === 'number' && route.estimate.estimatedRouteDuration > 0
        ? route.estimate.estimatedRouteDuration
        : 0,
    ...(transaction.requestId != null
      ? { requestId: transaction.requestId }
      : response.headers.get('x-request-id') != null
        ? { requestId: response.headers.get('x-request-id') as string }
        : {}),
  }
}

export function mapSquidStatus(status: string | undefined): {
  status: AcquisitionExecutionStatus
  errorCode?: AcquisitionErrorCode
} {
  switch (status) {
    case 'success':
      return { status: 'confirmed' }
    case 'partial_success':
      return { status: 'partial', errorCode: 'partial-success' }
    case 'refund':
      return { status: 'refunded', errorCode: 'refund-failed' }
    case 'ongoing':
    case 'not_found':
      return { status: 'submitted', errorCode: 'timed-out' }
    case 'needs_gas':
      return { status: 'failed', errorCode: 'insufficient-source-gas' }
    default:
      return { status: 'failed', errorCode: 'execution-failed' }
  }
}

/** Read a provider status using a transaction identifier retained from the source receipt. */
export async function pollSquidStatus(
  request: SquidStatusRequest,
  options: SquidProviderOptions
): Promise<SquidStatusResult> {
  if (!options.integratorId) throw providerError('Token acquisition requires SQUID_INTEGRATOR_ID')
  const fetchFn = options.fetchFn ?? fetch
  const params = new URLSearchParams({
    transactionId: request.transactionId,
    fromChainId: request.fromChainId,
    toChainId: request.toChainId,
    quoteId: request.quoteId,
  })
  if (request.requestId != null) params.set('requestId', request.requestId)
  const response = await squidFetch(
    `${SQUID_API_URL}/status?${params.toString()}`,
    { headers: { 'x-integrator-id': options.integratorId } },
    fetchFn
  )
  // A just-submitted transaction may not be indexed by the provider yet. Keep it in bounded polling.
  if (response.status === 404) return mapSquidStatus('not_found')
  if (!response.ok) throw providerError(`Squid status request failed (${response.status})`)
  const parsed = (await response.json()) as SquidStatusResponse
  return {
    ...mapSquidStatus(parsed.squidTransactionStatus),
    ...(parsed.fromChain?.transactionUrl != null ? { sourceTransactionUrl: parsed.fromChain.transactionUrl } : {}),
    ...(parsed.toChain?.transactionId != null ? { destinationTransactionHash: parsed.toChain.transactionId } : {}),
    ...(parsed.toChain?.transactionUrl != null ? { destinationTransactionUrl: parsed.toChain.transactionUrl } : {}),
    ...(parsed.axelarTransactionUrl != null ? { providerExplorerUrl: parsed.axelarTransactionUrl } : {}),
  }
}

/** Bounded polling never promotes an unresolved provider route to success. */
export async function waitForSquidTerminalStatus(options: {
  getStatus: () => Promise<{ status: AcquisitionExecutionStatus; errorCode?: AcquisitionErrorCode }>
  estimatedRouteDurationSeconds?: number
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
}): Promise<{ status: AcquisitionExecutionStatus; errorCode?: AcquisitionErrorCode }> {
  const now = options.now ?? Date.now
  const wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const start = now()
  const requestedDuration = options.estimatedRouteDurationSeconds ?? 0
  const estimatedRouteDurationSeconds =
    Number.isFinite(requestedDuration) && requestedDuration > 0
      ? Math.min(requestedDuration, MAX_ESTIMATED_ROUTE_DURATION_SECONDS)
      : 0
  const timeout = Math.max(15 * 60_000, estimatedRouteDurationSeconds * 2_000)
  let current: { status: AcquisitionExecutionStatus; errorCode?: AcquisitionErrorCode } = {
    status: 'submitted',
    errorCode: 'timed-out',
  }
  while (now() <= start + timeout) {
    current = await options.getStatus()
    if (current.status !== 'submitted') return current
    const remaining = start + timeout - now()
    if (remaining <= 0) break
    const cadence = now() - start < 2 * 60_000 ? 5_000 : 15_000
    await wait(Math.min(cadence, remaining))
  }
  return current
}
