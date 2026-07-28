import { parseUnits } from 'viem'
import { isFilecoinSameAssetFundingSource, LEGACY_SOURCE_DECIMALS } from './source-assets.js'
import type { ResolvedSourceToken } from './source-catalog.js'
import { getSquidRoute, type SquidProviderOptions } from './squid.js'
import type { AcquisitionLeg, PlannedAcquisitionQuote, WalletFundingPlan } from './types.js'

const MAX_PLANNING_ATTEMPTS = 4

function validatedSourceDecimals(source?: Pick<ResolvedSourceToken, 'decimals'> | { decimals?: number }): number {
  const decimals = source?.decimals ?? LEGACY_SOURCE_DECIMALS
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error('Resolved source token has invalid decimals')
  }
  return decimals
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator
}

/** Parse a positive user maximum in the selected source token's units. */
export function parseMaximumSourceAmount(
  value: string | undefined,
  source?: Pick<ResolvedSourceToken, 'decimals'> | { decimals?: number }
): bigint | undefined {
  if (value == null) return undefined
  const parsed = parseUnits(value, validatedSourceDecimals(source))
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
  for (const leg of options.plan.legs) assertLegIsNotFilecoinSelfFunding(leg, options.plan.source)
  const decimals = validatedSourceDecimals(options.plan.source)
  const defaultSeed = options.initialSourceAmount ?? 5n * 10n ** BigInt(Math.max(0, decimals - 1))
  const perLegSeed = options.maxSourceAmount / BigInt(options.plan.legs.length)
  if (perLegSeed <= 0n) {
    throw new Error(
      'Acquisition would spend more than --max-source-amount (each route needs at least one source base unit)'
    )
  }
  const seed = defaultSeed < perLegSeed ? defaultSeed : perLegSeed
  if (seed <= 0n) throw new Error('Initial source quote amount must be greater than zero')

  const states = options.plan.legs.map((leg) => ({
    leg,
    input: seed,
    quote: undefined as PlannedAcquisitionQuote | undefined,
    downscaled: false,
  }))
  for (let attempt = 0; attempt < MAX_PLANNING_ATTEMPTS; attempt += 1) {
    assertCandidateSourceTotal(states, options.maxSourceAmount)
    for (const state of states) {
      if (state.quote != null) continue
      try {
        state.quote = await getSquidRoute(
          { fromAddress: options.owner, sourceAmount: state.input, leg: state.leg, slippage: options.slippage },
          options.provider
        )
      } catch (error) {
        if (!state.downscaled) throw error
        throw new Error(
          'Squid could not quote the proportional source amount; the route may require a provider minimum, so fund directly rather than spending the seed quote',
          { cause: error }
        )
      }
    }
    const candidates = states.map((state) => {
      const quote = state.quote
      if (quote == null) throw new Error('Acquisition quote planning lost a requested route')
      return quote.destinationAmount <= 0n
        ? state.input
        : ceilDiv(state.input * state.leg.amount, quote.destinationAmount)
    })
    const hasZeroOutput = states.some((state) => state.quote?.destinationAmount === 0n)
    const hasShortfall = states.some((state) => state.quote != null && state.quote.destinationAmount < state.leg.amount)
    const hasCandidateChange = states.some((state, index) => candidates[index] !== state.input)
    if (!hasZeroOutput && !hasShortfall && !hasCandidateChange) {
      return states.map((state) => state.quote as PlannedAcquisitionQuote)
    }

    if (hasZeroOutput) {
      for (const state of states) {
        if (state.quote?.destinationAmount !== 0n) continue
        if (state.downscaled) {
          throw new Error(
            'Squid returned zero output for the proportional source amount; the route may require a provider minimum, so fund directly rather than spending the seed quote'
          )
        }
        state.quote = undefined
      }
    } else {
      // Re-quote every positive proportional candidate, including a candidate
      // smaller than a successful seed. Seed quotes are probes and must never
      // become executable merely because they already cover the shortfall.
      assertCandidateSourceTotal(
        candidates.map((input) => ({ input })),
        options.maxSourceAmount
      )
      for (const [index, state] of states.entries()) {
        const candidate = candidates[index]
        if (candidate == null) throw new Error('Acquisition quote planning lost a candidate input')
        if (candidate !== state.input) {
          state.downscaled = candidate < state.input
          state.input = candidate
          state.quote = undefined
        }
      }
    }
    if (attempt + 1 === MAX_PLANNING_ATTEMPTS) {
      if (hasZeroOutput) {
        throw new Error('Squid returned a zero minimum destination amount; cannot plan a safe acquisition')
      }
      throw new Error(`Squid could not converge on minimum safe source inputs within ${MAX_PLANNING_ATTEMPTS} quotes`)
    }
  }
  throw new Error('Acquisition quote planning ended unexpectedly')
}

function assertCandidateSourceTotal(states: Array<{ input: bigint }>, maxSourceAmount: bigint): void {
  const total = states.reduce((sum, state) => sum + state.input, 0n)
  if (total > maxSourceAmount) {
    throw new Error(`Acquisition would spend more than --max-source-amount (${total} source base units required)`)
  }
}

function assertLegIsNotFilecoinSelfFunding(leg: AcquisitionLeg, source: WalletFundingPlan['source']): void {
  if (source != null && isFilecoinSameAssetFundingSource(source, leg.asset)) {
    throw new Error('Selected Filecoin source asset cannot fund the same wallet shortfall; do not submit a route')
  }
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
  nativeSource?: boolean
}): void {
  const sourceAmount = totalSourceAmount(params.quotes)
  if (sourceAmount > params.maxSourceAmount) throw new Error('Acquisition exceeds --max-source-amount')
  const routeGas = params.quotes.reduce(
    (total, quote) => total + (params.nativeSource ? 0n : quote.value) + quote.gasLimit * quote.maxFeePerGas,
    0n
  )
  const approvalGas = (params.approvalGas ?? []).reduce((total, gas) => total + gas, 0n)
  const sourceGas = routeGas + approvalGas
  if (sourceGas > params.maxNativeGas) throw new Error('Acquisition exceeds the approved source-native gas cap')
}
