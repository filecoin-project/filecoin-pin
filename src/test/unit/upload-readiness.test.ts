import { parseEther } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkAllowances: vi.fn(),
  checkFILBalance: vi.fn(),
  checkUSDFCBalance: vi.fn(),
  getDepositedBalance: vi.fn(),
  setMaxAllowances: vi.fn(),
  validatePaymentCapacity: vi.fn(),
}))

vi.mock('../../core/payments/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/payments/index.js')>()),
  checkAllowances: mocks.checkAllowances,
  checkFILBalance: mocks.checkFILBalance,
  checkUSDFCBalance: mocks.checkUSDFCBalance,
  getDepositedBalance: mocks.getDepositedBalance,
  setMaxAllowances: mocks.setMaxAllowances,
  validatePaymentCapacity: mocks.validatePaymentCapacity,
}))

vi.mock('../../core/synapse/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/synapse/index.js')>()),
  isSessionKeyMode: vi.fn(() => false),
}))

import { checkUploadReadiness } from '../../core/upload/index.js'

describe('checkUploadReadiness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.checkFILBalance.mockResolvedValue({
      balance: parseEther('1'),
      isCalibnet: false,
      hasSufficientGas: true,
    })
    mocks.checkUSDFCBalance.mockResolvedValue(0n)
    mocks.getDepositedBalance.mockResolvedValue(parseEther('10'))
    mocks.checkAllowances.mockResolvedValue({ needsUpdate: false, currentAllowances: {} })
    mocks.validatePaymentCapacity.mockResolvedValue({
      canUpload: true,
      storageTiB: 0.001,
      required: {
        rateAllowance: 1n,
        lockupAllowance: 1n,
        storageCapacityTiB: 0.001,
      },
      issues: {},
      suggestions: [],
    })
  })

  it('allows uploads when wallet USDFC is zero but deposited capacity is sufficient', async () => {
    const result = await checkUploadReadiness({ synapse: {} as any, fileSize: 1024 })

    expect(result.status).toBe('ready')
    expect(result.validation).toEqual({ isValid: true })
    expect(result.walletUsdfcBalance).toBe(0n)
    expect(mocks.validatePaymentCapacity).toHaveBeenCalledWith({}, 1024)
  })

  it('still blocks before capacity checks when wallet FIL is insufficient for gas', async () => {
    mocks.checkFILBalance.mockResolvedValue({
      balance: 0n,
      isCalibnet: false,
      hasSufficientGas: false,
    })

    const result = await checkUploadReadiness({ synapse: {} as any, fileSize: 1024 })

    expect(result.status).toBe('blocked')
    expect(result.validation.errorMessage).toContain('Insufficient FIL for gas fees')
    expect(mocks.checkAllowances).not.toHaveBeenCalled()
    expect(mocks.validatePaymentCapacity).not.toHaveBeenCalled()
  })

  it('blocks a completely unfunded account before any allowance transaction', async () => {
    mocks.checkUSDFCBalance.mockResolvedValue(0n)
    mocks.getDepositedBalance.mockResolvedValue(0n)

    const result = await checkUploadReadiness({ synapse: {} as any, fileSize: 1024 })

    expect(result.status).toBe('blocked')
    expect(result.validation.errorMessage).toBe('No USDFC tokens found')
    expect(result.validation.helpMessage).toContain('Bridge USDFC to Filecoin mainnet')
    expect(mocks.checkAllowances).not.toHaveBeenCalled()
    expect(mocks.setMaxAllowances).not.toHaveBeenCalled()
    expect(mocks.validatePaymentCapacity).not.toHaveBeenCalled()
  })

  it('detects a completely unfunded account during the zero-size pre-flight check', async () => {
    // The `add` command runs a fileSize: 0 pre-flight to fail fast before
    // packing the CAR. A zero-size capacity check passes vacuously (nothing
    // to pay for), so the unfunded-account gate must catch this case.
    mocks.checkUSDFCBalance.mockResolvedValue(0n)
    mocks.getDepositedBalance.mockResolvedValue(0n)

    const result = await checkUploadReadiness({ synapse: {} as any, fileSize: 0 })

    expect(result.status).toBe('blocked')
    expect(result.validation.errorMessage).toBe('No USDFC tokens found')
    expect(mocks.setMaxAllowances).not.toHaveBeenCalled()
    expect(mocks.validatePaymentCapacity).not.toHaveBeenCalled()
  })

  it('uses the calibnet acquisition help for unfunded accounts on calibnet', async () => {
    mocks.checkFILBalance.mockResolvedValue({
      balance: parseEther('1'),
      isCalibnet: true,
      hasSufficientGas: true,
    })
    mocks.checkUSDFCBalance.mockResolvedValue(0n)
    mocks.getDepositedBalance.mockResolvedValue(0n)

    const result = await checkUploadReadiness({ synapse: {} as any, fileSize: 1024 })

    expect(result.status).toBe('blocked')
    expect(result.validation.helpMessage).toContain('Get test USDFC')
  })

  it('appends USDFC acquisition help when the wallet cannot cover the deposit shortfall', async () => {
    // Wallet holds some USDFC, but less than the 0.04 shortfall below.
    mocks.checkUSDFCBalance.mockResolvedValue(parseEther('0.001'))
    mocks.getDepositedBalance.mockResolvedValue(parseEther('0.01'))
    mocks.validatePaymentCapacity.mockResolvedValue({
      canUpload: false,
      storageTiB: 0.1,
      required: {
        rateAllowance: 1n,
        lockupAllowance: parseEther('0.05'),
        storageCapacityTiB: 0.1,
      },
      issues: { insufficientDeposit: parseEther('0.04') },
      suggestions: ['Deposit at least 0.04 USDFC'],
    })

    const result = await checkUploadReadiness({ synapse: {} as any, fileSize: 1024 })

    expect(result.status).toBe('blocked')
    const allSuggestions = result.suggestions.join('\n')
    expect(allSuggestions).toContain('Deposit at least 0.04 USDFC')
    expect(allSuggestions).toContain('Bridge USDFC to Filecoin mainnet')
    // Each suggestion renders as one bullet, so entries must be single-line
    for (const suggestion of result.suggestions) {
      expect(suggestion).not.toContain('\n')
    }
    // displayPaymentIssues prints capacity.suggestions, so the help must land there too
    expect(result.capacity?.suggestions).toEqual(result.suggestions)
  })

  it('does not append acquisition help when the wallet can cover the shortfall', async () => {
    mocks.checkUSDFCBalance.mockResolvedValue(parseEther('5'))
    mocks.getDepositedBalance.mockResolvedValue(parseEther('0.01'))
    mocks.validatePaymentCapacity.mockResolvedValue({
      canUpload: false,
      storageTiB: 0.1,
      required: {
        rateAllowance: 1n,
        lockupAllowance: parseEther('0.05'),
        storageCapacityTiB: 0.1,
      },
      issues: { insufficientDeposit: parseEther('0.04') },
      suggestions: ['Deposit at least 0.04 USDFC'],
    })

    const result = await checkUploadReadiness({ synapse: {} as any, fileSize: 1024 })

    expect(result.status).toBe('blocked')
    expect(result.suggestions).toEqual(['Deposit at least 0.04 USDFC'])
  })
})
