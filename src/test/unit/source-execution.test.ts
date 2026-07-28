import { describe, expect, it, vi } from 'vitest'
import {
  assertCheckpointSourceCompatibility,
  canAdoptHigherDestinationTarget,
  deserializeAcquisitionCheckpoint,
} from '../../core/payments/acquisition/checkpoint.js'
import { FILECOIN_USDFC } from '../../core/payments/acquisition/source-assets.js'
import {
  NATIVE_TOKEN_SELECTOR,
  type ResolvedSourceToken,
  SELECTED_SOURCE_CHAINS,
  TRUSTED_SQUID_ROUTE_POLICIES,
} from '../../core/payments/acquisition/source-catalog.js'
import {
  assertCumulativeSourceNativeGas,
  assertFilecoinSourceReserve,
  assertFilecoinUsdfcSourceReserve,
  getSelectedSourceBalance,
  requiresErc20Approval,
  sourceNativeGasCeiling,
  sourceRouteIdentity,
  verifySourceChain,
} from '../../core/payments/acquisition/source-execution.js'

const OWNER = '0x000000000000000000000000000000000000f00d' as const
function source(chainId: number, decimals = 18, native = false): ResolvedSourceToken {
  const chain = SELECTED_SOURCE_CHAINS.find((candidate) => candidate.chainId === chainId)
  if (chain == null) throw new Error('missing test chain')
  return {
    chain,
    chainId: chain.chainId,
    token: (native
      ? '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      : '0x1111111111111111111111111111111111111111') as `0x${string}`,
    symbol: native ? chain.nativeSymbol : 'TOK',
    decimals: native ? chain.nativeDecimals : decimals,
    native,
    display: native ? NATIVE_TOKEN_SELECTOR : 'TOK',
  }
}

describe('multi-chain selected-source execution substrate', () => {
  it.each(
    SELECTED_SOURCE_CHAINS.map((chain) => [chain.chainId])
  )('has an explicit fail-closed native-gas ceiling for chain %i', (chainId) => {
    expect(sourceNativeGasCeiling(chainId)).toBeGreaterThan(0n)
    expect(assertCumulativeSourceNativeGas({ chainId, committed: 1n, next: 2n })).toBe(3n)
  })

  it('has one complete, chain-keyed reviewed router policy for every selected source chain', () => {
    const selectedChainIds = SELECTED_SOURCE_CHAINS.map((chain) => chain.chainId).sort((left, right) => left - right)
    const policyChainIds = TRUSTED_SQUID_ROUTE_POLICIES.map((policy) => policy.chainId).sort(
      (left, right) => left - right
    )
    expect(policyChainIds).toEqual(selectedChainIds)
    expect(new Set(policyChainIds).size).toBe(policyChainIds.length)
    for (const policy of TRUSTED_SQUID_ROUTE_POLICIES) {
      expect(policy.allowedTargets).toHaveLength(1)
      expect(policy.allowedSpenders).toHaveLength(1)
    }
  })

  it('uses chain-bound ERC-20 source balances', async () => {
    const selected = source(43114, 18)
    const client = {
      getChainId: vi.fn().mockResolvedValue(43114),
      getBalance: vi.fn(),
      readContract: vi.fn().mockResolvedValue(9n),
    }
    await verifySourceChain(client as never, selected)
    await expect(getSelectedSourceBalance(client as never, OWNER, selected)).resolves.toBe(9n)
    expect(client.getBalance).not.toHaveBeenCalled()
  })

  it('uses native balances and never asks native sources for an approval', async () => {
    const selected = source(137, 18, true)
    const client = { getBalance: vi.fn().mockResolvedValue(7n), readContract: vi.fn() }
    await expect(getSelectedSourceBalance(client as never, OWNER, selected)).resolves.toBe(7n)
    expect(requiresErc20Approval(selected)).toBe(false)
    expect(client.readContract).not.toHaveBeenCalled()
  })

  it('preserves Filecoin FIL reserve for same-chain native and ERC-20 sources', () => {
    expect(() =>
      assertFilecoinSourceReserve({
        source: source(314, 18, true),
        nativeBalance: 99n,
        nativeRouteValue: 50n,
        routeAndApprovalGas: 20n,
        requiredFilecoinReserve: 30n,
      })
    ).toThrow('FIL reserve')
    expect(() =>
      assertFilecoinSourceReserve({
        source: source(314, 6),
        nativeBalance: 49n,
        nativeRouteValue: 1_000n,
        routeAndApprovalGas: 20n,
        requiredFilecoinReserve: 30n,
      })
    ).toThrow('FIL reserve')
  })

  it('permits an ERC-20 Filecoin route that refills FIL to spend only its signing costs up front', () => {
    expect(() =>
      assertFilecoinSourceReserve({
        source: source(314, 6),
        nativeBalance: 20n,
        nativeRouteValue: 0n,
        routeAndApprovalGas: 20n,
        requiredFilecoinReserve: 30n,
        replenishesFilecoinReserve: true,
      })
    ).not.toThrow()
  })

  it('reserves the Filecoin USDFC deposit target alongside every remaining fixed source input', () => {
    const filecoinUsdfc = { ...source(314, 18), token: FILECOIN_USDFC, symbol: 'USDFC' }
    expect(() =>
      assertFilecoinUsdfcSourceReserve({
        source: filecoinUsdfc,
        walletUsdfcBalance: 4n,
        pendingSourceAmount: 3n,
        requiredWalletUsdfc: 2n,
      })
    ).toThrow('plus the required post-route USDFC deposit')
    expect(() =>
      assertFilecoinUsdfcSourceReserve({
        source: filecoinUsdfc,
        walletUsdfcBalance: 5n,
        pendingSourceAmount: 3n,
        requiredWalletUsdfc: 2n,
      })
    ).not.toThrow()
  })

  it('rejects wrong-chain RPCs', async () => {
    const selected = source(43114, 18)
    await expect(verifySourceChain({ getChainId: vi.fn().mockResolvedValue(1) } as never, selected)).rejects.toThrow(
      'does not match selected source chain ID 43114'
    )
  })

  it('rejects legacy and mismatched recovery checkpoints instead of reinterpreting a source cap', () => {
    const selected = source(43114, 18)
    const identity = sourceRouteIdentity(selected)
    const checkpoint = {
      version: 2 as const,
      owner: OWNER,
      sourceChainId: 43114,
      destinationChainId: 314,
      committedNativeGas: 0n,
      source: identity,
      maxSourceAmount: 10n,
      maxNativeGas: sourceNativeGasCeiling(43114),
      requiredWallet: { fil: 0n, usdfc: 0n },
      evidence: [],
    }
    expect(() =>
      assertCheckpointSourceCompatibility(checkpoint, identity, 10n, sourceNativeGasCeiling(43114))
    ).not.toThrow()
    expect(() =>
      assertCheckpointSourceCompatibility({ ...checkpoint, version: 1 }, identity, 10n, sourceNativeGasCeiling(43114))
    ).toThrow('incompatible')
    expect(() => assertCheckpointSourceCompatibility(checkpoint, identity, 11n, sourceNativeGasCeiling(43114))).toThrow(
      'incompatible'
    )
    expect(() =>
      assertCheckpointSourceCompatibility(
        checkpoint,
        { ...identity, symbol: 'WRONG' },
        10n,
        sourceNativeGasCeiling(43114)
      )
    ).toThrow('incompatible')
    const higherCheckpoint = { ...checkpoint, requiredWallet: { fil: 20n, usdfc: 30n } }
    expect(() =>
      assertCheckpointSourceCompatibility(higherCheckpoint, identity, 10n, sourceNativeGasCeiling(43114), {
        fil: 10n,
        usdfc: 20n,
      })
    ).not.toThrow()
    expect(() =>
      assertCheckpointSourceCompatibility(checkpoint, identity, 10n, sourceNativeGasCeiling(43114), {
        fil: 1n,
        usdfc: 1n,
      })
    ).toThrow('destination target')

    const approvalOnlyCheckpoint = {
      ...checkpoint,
      committedNativeGas: 1n,
      approvalTransactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }
    expect(canAdoptHigherDestinationTarget(approvalOnlyCheckpoint)).toBe(true)
    expect(() =>
      assertCheckpointSourceCompatibility(approvalOnlyCheckpoint, identity, 10n, sourceNativeGasCeiling(43114), {
        fil: 1n,
        usdfc: 1n,
      })
    ).not.toThrow()
    const submittedRouteCheckpoint = {
      ...approvalOnlyCheckpoint,
      evidence: [{ asset: 'usdfc' as const, quoteId: 'submitted-route', status: 'submitted' as const }],
    }
    expect(canAdoptHigherDestinationTarget(submittedRouteCheckpoint)).toBe(false)
    expect(() =>
      assertCheckpointSourceCompatibility(submittedRouteCheckpoint, identity, 10n, sourceNativeGasCeiling(43114), {
        fil: 1n,
        usdfc: 1n,
      })
    ).toThrow('destination target')
  })

  it('rejects malformed persisted base-unit values with the checkpoint domain error', () => {
    expect(() => deserializeAcquisitionCheckpoint(null)).toThrow('Acquisition recovery state is invalid')
    expect(() =>
      deserializeAcquisitionCheckpoint({
        version: 2,
        owner: OWNER,
        sourceChainId: 43114,
        destinationChainId: 314,
        committedNativeGas: 'not-a-number',
        requiredWallet: { fil: '1', usdfc: '-1' },
        evidence: [],
      } as never)
    ).toThrow('Acquisition recovery state is invalid')
    expect(() =>
      deserializeAcquisitionCheckpoint({
        version: 2,
        owner: OWNER,
        sourceChainId: 43114,
        destinationChainId: 314,
        committedNativeGas: '1',
        requiredWallet: null,
        evidence: [],
      } as never)
    ).toThrow('Acquisition recovery state is invalid')
  })
})
