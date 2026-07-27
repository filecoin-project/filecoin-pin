import type { Address, PublicClient } from 'viem'
import { parseUnits } from 'viem'
import type { ResolvedSourceToken } from './source-catalog.js'

/**
 * Execution policy is deliberately explicit. A missing entry is a signing
 * failure, not an invitation to borrow a gas budget from a different chain.
 * Values are conservative native base-unit ceilings for one invocation.
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

export function equalSourceRouteIdentity(left: SourceRouteIdentity, right: SourceRouteIdentity): boolean {
  return (
    left.chainId === right.chainId &&
    left.token.toLowerCase() === right.token.toLowerCase() &&
    left.symbol === right.symbol &&
    left.decimals === right.decimals &&
    left.native === right.native
  )
}

/** Parse the invocation cap in exactly the resolved source asset's decimals. */
export function parseSourceAmountCap(value: string | undefined, source: ResolvedSourceToken): bigint | undefined {
  if (value == null) return undefined
  const cap = parseUnits(value, source.decimals)
  if (cap <= 0n) throw new Error('--max-source-amount must be greater than zero')
  return cap
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
  if (total > cap)
    throw new Error(`Source-native gas commitment ${total} exceeds chain ${options.chainId} ceiling ${cap}`)
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

/** Filecoin-source native routes must preserve both route gas and follow-on Filecoin Pay reserve. */
export function assertFilecoinSourceReserve(options: {
  source: ResolvedSourceToken
  nativeBalance: bigint
  sourceSpend: bigint
  routeAndApprovalGas: bigint
  requiredFilecoinReserve: bigint
}): void {
  if (options.source.chain.chainId !== 314) return
  const protectedBalance = options.routeAndApprovalGas + options.requiredFilecoinReserve
  const required = options.source.native ? options.sourceSpend + protectedBalance : protectedBalance
  if (options.nativeBalance < required) {
    throw new Error('Filecoin source balance would fall below the required FIL reserve; do not sign')
  }
}

export interface RefreshedRouteBinding {
  source: SourceRouteIdentity
  sourceAmount: bigint
  minimumDestinationAmount: bigint
  owner: Address
  destination: Address
  expiresAt: number
  target: Address
  spender: Address
}

/** All execution-bound quote facts are compared after every provider refresh. */
export function assertRefreshedRouteBinding(options: {
  planned: RefreshedRouteBinding
  refreshed: RefreshedRouteBinding
  trustedTarget: Address
  trustedSpender: Address
  nowSeconds?: number
}): void {
  const { planned, refreshed } = options
  if (!equalSourceRouteIdentity(planned.source, refreshed.source))
    throw new Error('Refreshed route source identity changed; do not sign')
  if (planned.sourceAmount !== refreshed.sourceAmount) throw new Error('Refreshed route input changed; do not sign')
  if (refreshed.minimumDestinationAmount < planned.minimumDestinationAmount)
    throw new Error('Refreshed route output fell below the planned minimum; do not sign')
  if (
    planned.owner.toLowerCase() !== refreshed.owner.toLowerCase() ||
    planned.destination.toLowerCase() !== refreshed.destination.toLowerCase()
  ) {
    throw new Error('Refreshed route owner or destination changed; do not sign')
  }
  if (
    refreshed.target.toLowerCase() !== options.trustedTarget.toLowerCase() ||
    refreshed.spender.toLowerCase() !== options.trustedSpender.toLowerCase()
  ) {
    throw new Error('Refreshed route target or approval spender is not trusted for the selected chain; do not sign')
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (refreshed.expiresAt <= now) throw new Error('Refreshed route expired; do not sign')
}
