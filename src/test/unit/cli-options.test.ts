import { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { DEFAULT_NETWORK } from '../../common/get-rpc-url.js'
import { addNetworkOptions, validateAndNormalizeAutoFundOptions } from '../../utils/cli-options.js'

describe('addNetworkOptions', () => {
  it('defaults shared CLI network options to mainnet', () => {
    const command = addNetworkOptions(new Command())
    const networkOption = command.options.find((option) => option.attributeName() === 'network')

    expect(networkOption?.defaultValue).toBe(DEFAULT_NETWORK)
  })
})

describe('validateAndNormalizeAutoFundOptions', () => {
  it('throws when --min-runway-days is set without --auto-fund', () => {
    expect(() => validateAndNormalizeAutoFundOptions({ minRunwayDays: 10 })).toThrow(
      '--min-runway-days requires --auto-fund'
    )
  })

  it('throws when --max-balance is set without --auto-fund', () => {
    expect(() => validateAndNormalizeAutoFundOptions({ maxBalance: '5.0' })).toThrow(
      '--max-balance requires --auto-fund'
    )
  })

  it('parses both modifiers when --auto-fund is set', () => {
    const result = validateAndNormalizeAutoFundOptions({
      autoFund: true,
      minRunwayDays: 365,
      maxBalance: '5.0',
    })
    expect(result.autoFund).toBe(true)
    expect(result.minRunwayDays).toBe(365)
    expect(result.maxBalance).toBe(5_000_000_000_000_000_000n) // 5 USDFC at 18 decimals
  })

  it('rejects non-positive --min-runway-days', () => {
    expect(() => validateAndNormalizeAutoFundOptions({ autoFund: true, minRunwayDays: 0 })).toThrow(
      /--min-runway-days must be a positive integer/
    )
  })
})
