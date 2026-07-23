import type { AcquisitionLeg, FundingSource, WalletFundingPath, WalletFundingPlan } from './acquisition/types.js'

export interface WalletShortfallInput {
  requiredUsdfc: bigint
  walletUsdfcBalance: bigint
  requiredFilReserve: bigint
  walletFilBalance: bigint
}

export interface WalletShortfalls {
  requiredUsdfc: bigint
  usdfcShortfall: bigint
  requiredFilReserve: bigint
  filShortfall: bigint
}

export interface PlanWalletFundingOptions extends WalletShortfallInput {
  /** One intentionally selected source; other wallet assets are not considered. */
  source?: FundingSource
}

function nonNegativeShortfall(required: bigint, available: bigint): bigint {
  return required > available ? required - available : 0n
}

/** Calculate exact FIL and USDFC deficits without treating either asset as interchangeable. */
export function calculateWalletShortfalls(input: WalletShortfallInput): WalletShortfalls {
  return {
    requiredUsdfc: input.requiredUsdfc,
    usdfcShortfall: nonNegativeShortfall(input.requiredUsdfc, input.walletUsdfcBalance),
    requiredFilReserve: input.requiredFilReserve,
    filShortfall: nonNegativeShortfall(input.requiredFilReserve, input.walletFilBalance),
  }
}

/** Classify a non-negative shortfall pair and optional selected-source availability. */
export function classifyWalletFundingPath(
  input: Pick<WalletShortfalls, 'usdfcShortfall' | 'filShortfall'> & { sourceAvailable?: boolean }
): WalletFundingPath {
  const needsUsdfc = input.usdfcShortfall > 0n
  const needsFil = input.filShortfall > 0n

  if (!needsUsdfc && !needsFil) return 'ready'
  if (input.sourceAvailable === false) return 'unsupported'
  if (!needsUsdfc) return 'acquire-fil'
  if (!needsFil) return 'acquire-usdfc'
  return 'acquire-both'
}

/** Create the provider-independent plan that later acquisition adapters consume. */
export function planWalletFunding(options: PlanWalletFundingOptions): WalletFundingPlan {
  const shortfalls = calculateWalletShortfalls(options)
  const classifiedPath = classifyWalletFundingPath({ ...shortfalls, sourceAvailable: options.source != null })
  const legs: AcquisitionLeg[] = []

  if (shortfalls.filShortfall > 0n) {
    legs.push({ asset: 'fil', amount: shortfalls.filShortfall, ...(options.source != null ? { source: options.source } : {}) })
  }
  if (shortfalls.usdfcShortfall > 0n) {
    legs.push({ asset: 'usdfc', amount: shortfalls.usdfcShortfall, ...(options.source != null ? { source: options.source } : {}) })
  }

  return {
    ...shortfalls,
    path: classifiedPath,
    ...(options.source != null ? { source: options.source } : {}),
    legs,
  }
}
