import { describe, expect, it } from 'vitest'
import type { AcquisitionProvider } from '../../core/payments/acquisition/provider.js'
import type {
  AcquisitionErrorCode,
  AcquisitionQuote,
  WalletFundingPlan,
} from '../../core/payments/acquisition/types.js'
import * as publicPayments from '../../core/payments/index.js'
import { classifyWalletFundingPath, planWalletFunding } from '../../core/payments/wallet-funding.js'

describe('wallet funding planning', () => {
  it('keeps wallet funding internals out of the published payments barrel', () => {
    expect(publicPayments).not.toHaveProperty('planWalletFunding')
    expect(publicPayments).not.toHaveProperty('classifyWalletFundingPath')
  })

  it('classifies each exact wallet shortfall combination', () => {
    expect(classifyWalletFundingPath({ usdfcShortfall: 0n, filShortfall: 0n })).toBe('ready')
    expect(classifyWalletFundingPath({ usdfcShortfall: 0n, filShortfall: 1n })).toBe('acquire-fil')
    expect(classifyWalletFundingPath({ usdfcShortfall: 1n, filShortfall: 0n })).toBe('acquire-usdfc')
    expect(classifyWalletFundingPath({ usdfcShortfall: 1n, filShortfall: 1n })).toBe('acquire-both')
    expect(classifyWalletFundingPath({ usdfcShortfall: -1n, filShortfall: 0n })).toBe('ready')
    expect(classifyWalletFundingPath({ usdfcShortfall: 1n, filShortfall: 0n, sourceAvailable: false })).toBe(
      'unsupported'
    )
  })

  it('returns unsupported without a selected acquisition source', () => {
    const plan = planWalletFunding({
      requiredUsdfc: 10n,
      walletUsdfcBalance: 4n,
      walletFilBalance: 0n,
      requiredFilReserve: 2n,
    })

    expect(plan.path).toBe('unsupported')
    expect(plan.usdfcShortfall).toBe(6n)
    expect(plan.filShortfall).toBe(2n)
  })

  it('keeps shortfalls non-negative and reserves FIL separately from USDFC', () => {
    const plan = planWalletFunding({
      requiredUsdfc: 10n,
      walletUsdfcBalance: 20n,
      walletFilBalance: 3n,
      requiredFilReserve: 2n,
    })

    expect(plan.path).toBe('ready')
    expect(plan.usdfcShortfall).toBe(0n)
    expect(plan.filShortfall).toBe(0n)
  })

  it('represents one selected source without aggregating wallet assets', () => {
    const plan = planWalletFunding({
      requiredUsdfc: 10n,
      walletUsdfcBalance: 10n,
      walletFilBalance: 0n,
      requiredFilReserve: 2n,
      source: { chainId: 10, token: 'USDC', symbol: 'USDC' },
    })

    expect(plan.path).toBe('acquire-fil')
    expect(plan.source).toEqual({ chainId: 10, token: 'USDC', symbol: 'USDC' })
  })

  it('admits a provider contract without a concrete provider', async () => {
    const quote: AcquisitionQuote = { id: 'quote-1', sourceAmount: 1n, destinationAmount: 2n }
    const provider: AcquisitionProvider = {
      quote: async () => quote,
      execute: async () => ({ id: 'execution-1', status: 'submitted' }),
      getStatus: async () => ({ id: 'execution-1', status: 'confirmed' }),
      buildFallbackUrl: () => 'https://example.test/fund',
    }
    const plan: WalletFundingPlan = planWalletFunding({
      requiredUsdfc: 0n,
      walletUsdfcBalance: 0n,
      walletFilBalance: 2n,
      requiredFilReserve: 2n,
    })

    expect(plan.path).toBe('ready')
    await expect(provider.quote({ plan })).resolves.toEqual(quote)
  })

  it('keeps the adapter error vocabulary provider-independent', () => {
    const errorCodes: AcquisitionErrorCode[] = [
      'unsupported-source',
      'insufficient-source-gas',
      'max-spend-exceeded',
      'quote-failed',
      'execution-failed',
      'timed-out',
      'partial-success',
      'refund-failed',
    ]

    expect(errorCodes).toHaveLength(8)
  })
})
