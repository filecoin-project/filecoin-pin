import { type Address, createPublicClient, http, type PublicClient } from 'viem'
import { arbitrum } from 'viem/chains'
import type { FundingSource } from './types.js'

export const ARBITRUM_CHAIN_ID = 42161
export const ARBITRUM_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831' as const
export const FILECOIN_MAINNET_CHAIN_ID = 314
export const FILECOIN_NATIVE_TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as const
export const FILECOIN_USDFC = '0x80b98d3aa09ffff255c3ba4a241111ff1262f045' as const
export const SQUID_ROUTER = '0xce16F69375520ab01377ce7B88f5BA8C48F8D666' as const

const source = {
  chainId: ARBITRUM_CHAIN_ID,
  token: ARBITRUM_USDC,
  symbol: 'USDC',
  decimals: 6,
} satisfies FundingSource

/** Resolve the intentionally small v1 source-asset allowlist. */
export function resolveSourceToken(chain: string | undefined, token: string | undefined): FundingSource | undefined {
  if (chain?.trim().toLowerCase() !== 'arb' || token?.trim().toUpperCase() !== 'USDC') return undefined
  return source
}

export function isSupportedSourceChain(chain: string | undefined): boolean {
  return chain?.trim().toLowerCase() === 'arb'
}

/** Source RPC is opt-in so normal Filecoin RPC selection is never reused as an Arbitrum endpoint. */
export function createSourceClient(rpcUrl: string | undefined): PublicClient {
  if (rpcUrl == null || rpcUrl.trim() === '') throw new Error('Acquisition requires --source-rpc-url or SOURCE_RPC_URL')
  return createPublicClient({ chain: arbitrum, transport: http(rpcUrl) })
}

const erc20BalanceOf = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
] as const

export async function getSourceWalletBalances(
  client: PublicClient,
  address: Address
): Promise<{
  native: bigint
  usdc: bigint
}> {
  const [native, usdc] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({ address: ARBITRUM_USDC, abi: erc20BalanceOf, functionName: 'balanceOf', args: [address] }),
  ])
  return { native, usdc }
}
