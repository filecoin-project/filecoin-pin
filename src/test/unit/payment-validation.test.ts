import { parseEther } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  getUsdfcAcquisitionHelpMessage,
  validateGasRequirement,
  validatePaymentRequirements,
} from '../../core/payments/index.js'

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

describe('validateGasRequirement', () => {
  it('passes at or above the minimum', () => {
    expect(validateGasRequirement(parseEther('0.1'), false).isValid).toBe(true)
    expect(validateGasRequirement(parseEther('1'), false).isValid).toBe(true)
  })

  it('reports balance, minimum, and shortfall when below the minimum', () => {
    const result = validateGasRequirement(parseEther('0.0989'), false)

    expect(result.isValid).toBe(false)
    expect(result.errorMessage).toContain('balance: 0.0989 FIL')
    expect(result.errorMessage).toContain('minimum: 0.1000 FIL')
    expect(result.errorMessage).toContain('add at least: 0.0011 FIL')
  })

  it('points at the FIL faucet on calibration', () => {
    const result = validateGasRequirement(0n, true)

    expect(result.isValid).toBe(false)
    expect(result.errorMessage).toContain('tFIL')
    expect(result.helpMessage).toContain('faucet.calibnet.chainsafe-fil.io')
  })
})

describe('validatePaymentRequirements', () => {
  it('surfaces the mainnet USDFC docs when wallet balance is zero', () => {
    const result = validatePaymentRequirements(parseEther('1'), 0n, false)

    expect(result.isValid).toBe(false)
    expect(result.errorMessage).toBe('No USDFC tokens found')
    expect(result.helpMessage).toContain('https://app.usdfc.net/#/bridge')
  })

  it('reports the gas shortfall before the USDFC check', () => {
    const result = validatePaymentRequirements(0n, 0n, false)

    expect(result.isValid).toBe(false)
    expect(result.errorMessage).toContain('Insufficient FIL for gas fees')
    expect(result.errorMessage).toContain('add at least: 0.1000 FIL')
  })
})
