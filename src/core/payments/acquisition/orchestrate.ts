import { mainnet } from '../../synapse/index.js'
import { MIN_FIL_FOR_GAS } from '../constants.js'
import { planWalletFunding } from '../wallet-funding.js'
import {
  type AcquisitionCheckpoint,
  acquireAcquisitionLock,
  assertCheckpointSourceCompatibility,
  createAcquisitionCheckpointStore,
} from './checkpoint.js'
import {
  executeTokenAcquisition,
  MAX_SOURCE_NATIVE_GAS,
  sourceAddressForPrivateKey,
  waitForFilecoinWalletReadiness,
} from './execute.js'
import {
  parseMaximumSourceAmount,
  planTokenAcquisition,
  refreshFixedInputAcquisitionQuote,
  totalSourceAmount,
  validateMaximumSourceSpend,
} from './plan.js'
import { resolveSourceToken } from './source-assets.js'
import type { ResolvedSourceToken } from './source-catalog.js'
import { sourceNativeGasCeiling, sourceRouteIdentity } from './source-execution.js'
import { pollSquidStatus, type SquidProviderOptions } from './squid.js'
import type { AcquisitionEvidence } from './types.js'

function consumedSourceAmount(evidence: AcquisitionEvidence[]): bigint {
  return evidence.reduce((total, item) => {
    if (item.sourceAmount == null || !/^\d+$/.test(item.sourceAmount)) {
      throw new Error('Acquisition recovery state lacks a valid consumed source amount; do not submit another route')
    }
    return total + BigInt(item.sourceAmount)
  }, 0n)
}

export interface EnsureWalletReadyOptions {
  /** Resolved destination chain id, never a requested CLI network label. */
  destinationChainId: number
  walletUsdfcBalance: bigint
  walletFilBalance: bigint
  requiredUsdfc: bigint
  fromChain?: string | undefined
  fromToken?: string | undefined
  /** Internal #16 seam: the exact source resolved by the #15 catalog contract. */
  resolvedSource?: ResolvedSourceToken | undefined
  maxSourceAmount?: string | undefined
  sourceRpcUrl?: string | undefined
  slippage?: number | undefined
  privateKey?: string | undefined
  provider: SquidProviderOptions
  /** Called after routes are validated and before any source approval or signature. */
  confirmSourceAcquisition?: ((summary: SourceAcquisitionConfirmation) => Promise<void>) | undefined
  rereadWalletBalances: () => Promise<{ fil: bigint; usdfc: bigint }>
}

/** Safe-to-display source-route facts; it intentionally excludes calldata and provider credentials. */
export interface SourceAcquisitionConfirmation {
  sourceChainId?: number
  maxNativeGas?: bigint
  sourceAmount: bigint
  maxSourceAmount: bigint
  legs: Array<{ asset: 'fil' | 'usdfc'; minimumDestinationAmount: bigint; expiresAt: number }>
}

/**
 * A ready retry may observe balances that arrived after an earlier command
 * timed out. Clear only state that belongs to this exact acquisition and has
 * no unresolved broadcast intent; such an intent must remain durable so a
 * later underfunded run cannot accidentally submit the same nonce twice.
 */
function canClearReadyCheckpoint(options: {
  checkpoint: AcquisitionCheckpoint
  owner: string
  sourceChainId: number
  destinationChainId: number
  walletFilBalance: bigint
  walletUsdfcBalance: bigint
}): boolean {
  const { checkpoint } = options
  return (
    checkpoint.owner.toLowerCase() === options.owner.toLowerCase() &&
    checkpoint.sourceChainId === options.sourceChainId &&
    checkpoint.destinationChainId === options.destinationChainId &&
    checkpoint.approvalIntent == null &&
    checkpoint.approvalTransactionHash == null &&
    checkpoint.routeIntent == null &&
    checkpoint.evidence.every((item) => item.sourceTransactionHash != null) &&
    options.walletFilBalance >= checkpoint.requiredWallet.fil &&
    options.walletUsdfcBalance >= checkpoint.requiredWallet.usdfc
  )
}

async function clearCompatibleReadyCheckpoint(
  options: EnsureWalletReadyOptions,
  source: NonNullable<ReturnType<typeof resolveSourceToken>> | ResolvedSourceToken
): Promise<void> {
  if (options.maxSourceAmount == null || options.privateKey == null) return
  const privateKey = (
    options.privateKey.startsWith('0x') ? options.privateKey : `0x${options.privateKey}`
  ) as `0x${string}`
  const sourceOwner = sourceAddressForPrivateKey(privateKey)
  const lock = await acquireAcquisitionLock(sourceOwner)
  const checkpointStore = createAcquisitionCheckpointStore(sourceOwner)
  try {
    const pending = await checkpointStore.load()
    if (pending != null && options.resolvedSource != null && options.maxSourceAmount != null) {
      assertCheckpointSourceCompatibility(
        pending,
        sourceRouteIdentity(options.resolvedSource),
        parseMaximumSourceAmount(options.maxSourceAmount, options.resolvedSource) as bigint,
        sourceNativeGasCeiling(options.resolvedSource.chain.chainId)
      )
    }
    if (
      pending != null &&
      canClearReadyCheckpoint({
        checkpoint: pending,
        owner: sourceOwner,
        sourceChainId: source.chainId,
        destinationChainId: options.destinationChainId,
        walletFilBalance: options.walletFilBalance,
        walletUsdfcBalance: options.walletUsdfcBalance,
      })
    ) {
      await checkpointStore.clear()
    }
  } finally {
    await lock.release()
  }
}

/** Ensure only the exact wallet deficits are acquired before the existing deposit path continues. */
export async function ensureWalletReadyForFilecoinTransactions(
  options: EnsureWalletReadyOptions
): Promise<AcquisitionEvidence[]> {
  const source = options.resolvedSource ?? resolveSourceToken(options.fromChain, options.fromToken)
  if (options.resolvedSource != null && options.resolvedSource.chainId !== options.resolvedSource.chain.chainId) {
    throw new Error('Resolved source chain identity is inconsistent; do not acquire')
  }
  // The status read that led to this workflow can be stale while an operator
  // completes a direct top-up. Acquire only against the last destination view
  // available before we calculate shortfalls or contact the provider.
  const currentWallet = await options.rereadWalletBalances()
  const plan = planWalletFunding({
    requiredUsdfc: options.requiredUsdfc,
    walletUsdfcBalance: currentWallet.usdfc,
    requiredFilReserve: MIN_FIL_FOR_GAS,
    walletFilBalance: currentWallet.fil,
    ...(source != null ? { source } : {}),
  })
  if (plan.path === 'ready') {
    if (source != null) {
      await clearCompatibleReadyCheckpoint(
        { ...options, walletFilBalance: currentWallet.fil, walletUsdfcBalance: currentWallet.usdfc },
        source
      )
    }
    return []
  }
  if (options.destinationChainId !== mainnet.id) {
    throw new Error(
      'Token acquisition is available only on Filecoin mainnet; use a direct USDFC deposit on this network'
    )
  }
  if (options.maxSourceAmount == null || source == null || options.privateKey == null) {
    throw new Error(
      'Underfunded wallet: specify --from-chain arb --from-token USDC --max-source-amount and an owner private key'
    )
  }
  const privateKey = (
    options.privateKey.startsWith('0x') ? options.privateKey : `0x${options.privateKey}`
  ) as `0x${string}`
  const sourceOwner = sourceAddressForPrivateKey(privateKey)
  const lock = await acquireAcquisitionLock(sourceOwner)
  const checkpointStore = createAcquisitionCheckpointStore(sourceOwner)
  try {
    const pending = await checkpointStore.load()
    if (pending?.approvalIntent != null || pending?.routeIntent != null) {
      throw new Error(
        'Acquisition has a pre-broadcast intent without a transaction hash; inspect the recorded nonce before any rerun'
      )
    }
    const maximumSourceAmount = parseMaximumSourceAmount(options.maxSourceAmount, source) as bigint
    const completedAssets = new Set(pending?.evidence.map((item) => item.asset) ?? [])
    const remainingPlan = { ...plan, legs: plan.legs.filter((leg) => !completedAssets.has(leg.asset)) }
    const needsRoutePlanning =
      pending == null ||
      (pending.evidence.length === 0 && pending.approvalIntent == null && pending.routeIntent == null) ||
      remainingPlan.legs.length > 0
    const priorSourceAmount =
      needsRoutePlanning && pending != null && pending.evidence.length > 0 ? consumedSourceAmount(pending.evidence) : 0n
    if (priorSourceAmount > maximumSourceAmount) {
      throw new Error('Acquisition recovery state exceeds --max-source-amount; do not submit another route')
    }
    const remainingSourceAmount = maximumSourceAmount - priorSourceAmount
    const quotes = needsRoutePlanning
      ? await planTokenAcquisition({
          plan: remainingPlan,
          owner: sourceOwner,
          maxSourceAmount: remainingSourceAmount,
          slippage: options.slippage ?? 1,
          provider: options.provider,
        })
      : []
    if (needsRoutePlanning) {
      validateMaximumSourceSpend({
        quotes,
        maxSourceAmount: remainingSourceAmount,
        maxNativeGas:
          options.resolvedSource != null
            ? sourceNativeGasCeiling(options.resolvedSource.chain.chainId)
            : MAX_SOURCE_NATIVE_GAS,
        ...(options.resolvedSource != null ? { nativeSource: options.resolvedSource.native } : {}),
      })
      if (quotes.length > 0) {
        await options.confirmSourceAcquisition?.({
          sourceAmount: totalSourceAmount(quotes),
          maxSourceAmount: remainingSourceAmount,
          ...(options.resolvedSource != null
            ? {
                sourceChainId: source.chainId,
                maxNativeGas: sourceNativeGasCeiling(options.resolvedSource.chain.chainId),
              }
            : {}),
          legs: quotes.map((quote) => ({
            asset: quote.asset,
            minimumDestinationAmount: quote.destinationAmount,
            expiresAt: quote.expiresAt,
          })),
        })
      }
    }
    const evidence = await executeTokenAcquisition({
      privateKey,
      sourceRpcUrl: options.sourceRpcUrl,
      ...(options.resolvedSource != null
        ? {
            source: options.resolvedSource,
            requiredFilecoinReserve: MIN_FIL_FOR_GAS,
            requiredDestinationWallet: { fil: MIN_FIL_FOR_GAS, usdfc: options.requiredUsdfc },
          }
        : {}),
      quotes,
      maxSourceAmount: maximumSourceAmount,
      refreshQuote: async (quote) => {
        const leg = plan.legs.find((candidate) => candidate.asset === quote.asset)
        if (leg == null) throw new Error('Acquisition quote does not match a planned wallet shortfall')
        return refreshFixedInputAcquisitionQuote({
          quote,
          leg,
          owner: sourceOwner,
          slippage: options.slippage ?? 1,
          provider: options.provider,
        })
      },
      getProviderStatus: async (current) => {
        if (current.sourceTransactionHash == null) {
          throw new Error('Acquisition evidence has no source transaction hash; do not resubmit the source route')
        }
        return pollSquidStatus(
          {
            transactionId: current.sourceTransactionHash,
            fromChainId: String(source.chainId),
            toChainId: String(options.destinationChainId),
            quoteId: current.quoteId,
            ...(current.requestId != null ? { requestId: current.requestId } : {}),
          },
          options.provider
        )
      },
      checkpointStore,
      destinationChainId: options.destinationChainId,
      getFilecoinBalances: options.rereadWalletBalances,
      waitForFilecoinArrival: async (required) =>
        waitForFilecoinWalletReadiness({ required, getBalances: options.rereadWalletBalances }),
    })
    await waitForFilecoinWalletReadiness({
      required: { fil: MIN_FIL_FOR_GAS, usdfc: options.requiredUsdfc },
      getBalances: options.rereadWalletBalances,
    })
    return evidence
  } finally {
    await lock.release()
  }
}
