import { describe, expect, it } from 'vitest'
import { getUsdfcAcquisitionHelpMessage, validatePaymentRequirements } from '../../core/payments/index.js'

describe('getUsdfcAcquisitionHelpMessage', () => {
  it('returns testnet USDFC docs on calibration', () => {
    expect(getUsdfcAcquisitionHelpMessage(true)).toContain('getting-test-usdfc-on-testnet')
  })

  it('returns mainnet USDFC bridge docs on mainnet', () => {
    const helpMessage = getUsdfcAcquisitionHelpMessage(false)

    expect(helpMessage).toContain('https://app.usdfc.net/#/bridge')
    expect(helpMessage).toContain(
      'https://www.sushi.com/filecoin/swap?token0=NATIVE&token1=0x80b98d3aa09ffff255c3ba4a241111ff1262f045'
    )
    expect(helpMessage).toContain('minting-usdfc-step-by-step')
  })
})

describe('validatePaymentRequirements', () => {
  it('surfaces the mainnet USDFC docs when wallet balance is zero', () => {
    const result = validatePaymentRequirements(true, 0n, false)

    expect(result.isValid).toBe(false)
    expect(result.errorMessage).toBe('No USDFC tokens found')
    expect(result.helpMessage).toContain('https://app.usdfc.net/#/bridge')
  })
})
