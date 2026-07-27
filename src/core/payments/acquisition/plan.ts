import { parseUnits } from 'viem'
import type { ResolvedSourceToken } from './source-catalog.js'
import { getSquidRoute, type SquidProviderOptions } from './squid.js'
import type { AcquisitionLeg, PlannedAcquisitionQuote, WalletFundingPlan } from './types.js'

const MAX_PLANNING_ATTEMPTS = 4

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator
}

/** Parse a positive user maximum in the selected source token's units. */
export function parseMaximumSourceAmount(
  value: string | undefined,
  source?: Pick<ResolvedSourceToken, 'decimals'>
): bigint | undefined {
  if (value == null) return undefined
  const parsed = parseUnits(value, source?.decimals ?? 6)
  if (parsed <= 0n) throw new Error('--max-source-amount must be greater than zero')
  return parsed
}

export interface PlanTokenAcquisitionOptions {
  plan: WalletFundingPlan
  owner: `0x${string}`
  maxSourceAmount: bigint
  slippage: number
  provider: SquidProviderOptions
  /** A conservative source amount used only to seed the output-driven quote loop. */
  initialSourceAmount?: bigint
}

export interface RefreshFixedInputAcquisitionQuoteOptions {
  quote: PlannedAcquisitionQuote
  leg: AcquisitionLeg
  owner: `0x${string}`
  slippage: number
  provider: SquidProviderOptions
}

/**
 * Find fixed source inputs that meet exact downstream shortfalls without
 * estimating Filecoin pricing. Every returned quote is independently
 * allowlist-validated by getSquidRoute.
 */
export async function planTokenAcquisition(options: PlanTokenAcquisitionOptions): Promise<PlannedAcquisitionQuote[]> {
  if (options.plan.path === 'ready') return []
  if (options.plan.path === 'unsupported' || options.plan.source == null) {
    throw new Error('A supported --from-chain and --from-token are required to acquire wallet shortfalls')
  }
  const quotes: PlannedAcquisitionQuote[] = []
  let total = 0n
  for (const leg of options.plan.legs) {
    const quote = await planLeg(leg, options)
    total += quote.sourceAmount
    if (total > options.maxSourceAmount) {
      throw new Error(`Acquisition would spend more than --max-source-amount (${total} source base units required)`)
    }
    quotes.push(quote)
  }
  return quotes
}

/**
 * Re-fetch one executable route after an approval without changing its fixed
 * source input. Refreshes never use output-driven planning because an approval
 * may already exist for the original source-token amount.
 */
export async function refreshFixedInputAcquisitionQuote(
  options: RefreshFixedInputAcquisitionQuoteOptions
): Promise<PlannedAcquisitionQuote> {
  if (options.quote.asset !== options.leg.asset) {
    throw new Error('Acquisition quote does not match a planned wallet shortfall')
  }
  const refreshed = await getSquidRoute(
    {
      fromAddress: options.owner,
      sourceAmount: options.quote.sourceAmount,
      leg: options.leg,
      slippage: options.slippage,
    },
    options.provider
  )
  if (refreshed.destinationAmount < options.leg.amount) {
    throw new Error('Squid route refresh no longer covers the planned wallet shortfall; do not submit the route')
  }
  if (
    refreshed.asset !== options.quote.asset ||
    refreshed.sourceAmount !== options.quote.sourceAmount ||
    refreshed.destinationAmount < options.quote.destinationAmount
  ) {
    throw new Error('Squid route changed after refresh; do not submit the route')
  }
  return refreshed
}

async function planLeg(leg: AcquisitionLeg, options: PlanTokenAcquisitionOptions): Promise<PlannedAcquisitionQuote> {
  // The probe scales with the resolved token, rather than embedding a USDC
  // base-unit or fiat-value assumption. Subsequent iterations are driven only
  // by the returned output amount.
  const decimals = options.plan.source?.decimals ?? 6
  let input = options.initialSourceAmount ?? 5n * 10n ** BigInt(Math.max(0, decimals - 1))
  for (let attempt = 0; attempt < MAX_PLANNING_ATTEMPTS; attempt += 1) {
    const quote = await getSquidRoute(
      { fromAddress: options.owner, sourceAmount: input, leg, slippage: options.slippage },
      options.provider
    )
    if (quote.destinationAmount <= 0n) {
      if (attempt + 1 === MAX_PLANNING_ATTEMPTS) {
        throw new Error('Squid returned a zero minimum destination amount; cannot plan a safe acquisition')
      }
      continue
    }
    if (quote.destinationAmount >= leg.amount) return quote
    input = ceilDiv(input * leg.amount, quote.destinationAmount)
  }
  throw new Error(
    `Squid could not satisfy the required ${leg.asset.toUpperCase()} output within ${MAX_PLANNING_ATTEMPTS} quotes`
  )
}

export function totalSourceAmount(quotes: PlannedAcquisitionQuote[]): bigint {
  return quotes.reduce((total, quote) => total + quote.sourceAmount, 0n)
}

/** Ensure all planned source operations fit both operator-enforced caps. */
export function validateMaximumSourceSpend(params: {
  quotes: PlannedAcquisitionQuote[]
  maxSourceAmount: bigint
  maxNativeGas: bigint
  /** Estimated costs of exact ERC-20 approval/replacement transactions. */
  approvalGas?: bigint[]
}): void {
  const sourceAmount = totalSourceAmount(params.quotes)
  if (sourceAmount > params.maxSourceAmount) throw new Error('Acquisition exceeds --max-source-amount')
  const routeGas = params.quotes.reduce((total, quote) => total + quote.value + quote.gasLimit * quote.maxFeePerGas, 0n)
  const approvalGas = (params.approvalGas ?? []).reduce((total, gas) => total + gas, 0n)
  const sourceGas = routeGas + approvalGas
  if (sourceGas > params.maxNativeGas) throw new Error('Acquisition exceeds the approved source-native gas cap')
}
