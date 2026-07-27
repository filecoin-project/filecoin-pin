import type { Address, PublicClient } from 'viem'
import type { ResolvedSourceToken } from './source-catalog.js'

/**
 * Execution policy is deliberately explicit. A missing entry is a signing
 * failure, not an invitation to borrow a gas budget from a different chain.
 * Values are conservative native base-unit ceilings for one invocation, covering gas and ERC-20 route value.
 */
export const SOURCE_NATIVE_GAS_CEILINGS: Readonly<Record<number, bigint>> = {
  1: 30_000_000_000_000_000n,
  10: 3_000_000_000_000_000n,
  56: 5_000_000_000_000_000n,
  137: 10_000_000_000_000_000n,
  314: 30_000_000_000_000_000n,
  8453: 3_000_000_000_000_000n,
  42161: 3_000_000_000_000_000n,
  43114: 10_000_000_000_000_000n,
}

export interface SourceRouteIdentity {
  chainId: number
  token: Address
  symbol: string
  decimals: number
  native: boolean
}

export function sourceRouteIdentity(source: ResolvedSourceToken): SourceRouteIdentity {
  return {
    chainId: source.chain.chainId,
    token: source.token,
    symbol: source.symbol,
    decimals: source.decimals,
    native: source.native,
  }
}

export function sourceNativeGasCeiling(chainId: number): bigint {
  const cap = SOURCE_NATIVE_GAS_CEILINGS[chainId]
  if (cap == null)
    throw new Error(`No approved source-native gas ceiling is configured for chain ${chainId}; do not sign`)
  return cap
}

export function assertCumulativeSourceNativeGas(options: { chainId: number; committed: bigint; next: bigint }): bigint {
  const cap = sourceNativeGasCeiling(options.chainId)
  const total = options.committed + options.next
  if (total > cap) throw new Error(`Source-native commitment ${total} exceeds chain ${options.chainId} ceiling ${cap}`)
  return total
}

export async function verifySourceChain(
  client: Pick<PublicClient, 'getChainId'>,
  source: ResolvedSourceToken
): Promise<void> {
  const actual = await client.getChainId()
  if (actual !== source.chain.chainId) {
    throw new Error(
      `Source RPC chain ID ${actual} does not match selected source chain ID ${source.chain.chainId}; do not sign`
    )
  }
}

const balanceOfAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
] as const

/** Read only the exact selected asset, preserving native/ERC-20 distinction. */
export async function getSelectedSourceBalance(
  client: Pick<PublicClient, 'getBalance' | 'readContract'>,
  owner: Address,
  source: ResolvedSourceToken
): Promise<bigint> {
  if (source.native) return client.getBalance({ address: owner })
  return client.readContract({ address: source.token, abi: balanceOfAbi, functionName: 'balanceOf', args: [owner] })
}

/** Native sources are sent as transaction value and must never create an ERC-20 approval. */
export function requiresErc20Approval(source: ResolvedSourceToken): boolean {
  return !source.native
}

/** Filecoin source routes must preserve native route value, gas, and the follow-on Filecoin Pay reserve. */
export function assertFilecoinSourceReserve(options: {
  source: ResolvedSourceToken
  nativeBalance: bigint
  nativeRouteValue: bigint
  routeAndApprovalGas: bigint
  requiredFilecoinReserve: bigint
}): void {
  if (options.source.chain.chainId !== 314) return
  const required = options.nativeRouteValue + options.routeAndApprovalGas + options.requiredFilecoinReserve
  if (options.nativeBalance < required) {
    throw new Error('Filecoin source balance would fall below the required FIL reserve; do not sign')
  }
}
