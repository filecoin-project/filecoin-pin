import { describe, expect, it, vi } from 'vitest'
import { assertCheckpointSourceCompatibility } from '../../core/payments/acquisition/checkpoint.js'
import {
  NATIVE_TOKEN_SELECTOR,
  type ResolvedSourceToken,
  SELECTED_SOURCE_CHAINS,
} from '../../core/payments/acquisition/source-catalog.js'
import {
  assertCumulativeSourceNativeGas,
  assertFilecoinSourceReserve,
  assertRefreshedRouteBinding,
  getSelectedSourceBalance,
  parseSourceAmountCap,
  requiresErc20Approval,
  sourceNativeGasCeiling,
  sourceRouteIdentity,
  verifySourceChain,
} from '../../core/payments/acquisition/source-execution.js'

const OWNER = '0x000000000000000000000000000000000000f00d' as const
const TARGET = '0x000000000000000000000000000000000000beef' as const

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
  it.each([
    1, 10, 56, 137, 314, 8453, 42161, 43114,
  ])('has an explicit fail-closed native-gas ceiling for chain %i', (chainId) => {
    expect(sourceNativeGasCeiling(chainId)).toBeGreaterThan(0n)
    expect(assertCumulativeSourceNativeGas({ chainId, committed: 1n, next: 2n })).toBe(3n)
  })

  it('uses non-six-decimal ERC-20 source amounts and chain-bound balances', async () => {
    const selected = source(8453, 18)
    expect(parseSourceAmountCap('1.25', selected)).toBe(1_250_000_000_000_000_000n)
    const client = {
      getChainId: vi.fn().mockResolvedValue(8453),
      getBalance: vi.fn(),
      readContract: vi.fn().mockResolvedValue(9n),
    }
    await verifySourceChain(client as never, selected)
    await expect(getSelectedSourceBalance(client as never, OWNER, selected)).resolves.toBe(9n)
    expect(client.getBalance).not.toHaveBeenCalled()
  })

  it('uses native balances and never asks native sources for an approval', async () => {
    const selected = source(10, 18, true)
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
        sourceSpend: 50n,
        routeAndApprovalGas: 20n,
        requiredFilecoinReserve: 30n,
      })
    ).toThrow('FIL reserve')
    expect(() =>
      assertFilecoinSourceReserve({
        source: source(314, 6),
        nativeBalance: 49n,
        sourceSpend: 1_000n,
        routeAndApprovalGas: 20n,
        requiredFilecoinReserve: 30n,
      })
    ).toThrow('FIL reserve')
  })

  it('rejects wrong-chain RPCs and untrusted refreshed quote identity', async () => {
    const selected = source(8453, 18)
    await expect(verifySourceChain({ getChainId: vi.fn().mockResolvedValue(1) } as never, selected)).rejects.toThrow(
      'does not match selected source chain ID 8453'
    )
    const binding = {
      source: sourceRouteIdentity(selected),
      sourceAmount: 1n,
      minimumDestinationAmount: 2n,
      owner: OWNER,
      destination: OWNER,
      expiresAt: 2_000_000_000,
      target: TARGET,
      spender: TARGET,
    }
    expect(() =>
      assertRefreshedRouteBinding({
        planned: binding,
        refreshed: { ...binding, source: { ...binding.source, decimals: 6 } },
        trustedTarget: TARGET,
        trustedSpender: TARGET,
      })
    ).toThrow('source identity')
  })

  it('rejects legacy and mismatched recovery checkpoints instead of reinterpreting a source cap', () => {
    const selected = source(8453, 18)
    const identity = sourceRouteIdentity(selected)
    const checkpoint = {
      version: 2 as const,
      owner: OWNER,
      sourceChainId: 8453,
      destinationChainId: 314,
      committedNativeGas: 0n,
      source: identity,
      maxSourceAmount: 10n,
      maxNativeGas: sourceNativeGasCeiling(8453),
      requiredWallet: { fil: 0n, usdfc: 0n },
      evidence: [],
    }
    expect(() =>
      assertCheckpointSourceCompatibility(checkpoint, identity, 10n, sourceNativeGasCeiling(8453))
    ).not.toThrow()
    expect(() =>
      assertCheckpointSourceCompatibility({ ...checkpoint, version: 1 }, identity, 10n, sourceNativeGasCeiling(8453))
    ).toThrow('incompatible')
    expect(() => assertCheckpointSourceCompatibility(checkpoint, identity, 11n, sourceNativeGasCeiling(8453))).toThrow(
      'incompatible'
    )
    expect(() =>
      assertCheckpointSourceCompatibility(
        checkpoint,
        { ...identity, symbol: 'WRONG' },
        10n,
        sourceNativeGasCeiling(8453)
      )
    ).toThrow('incompatible')
  })
})
