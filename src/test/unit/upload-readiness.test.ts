import { parseEther } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkAllowances: vi.fn(),
  checkFILBalance: vi.fn(),
  checkUSDFCBalance: vi.fn(),
  setMaxAllowances: vi.fn(),
  validatePaymentCapacity: vi.fn(),
}))

vi.mock('../../core/payments/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/payments/index.js')>()),
  checkAllowances: mocks.checkAllowances,
  checkFILBalance: mocks.checkFILBalance,
  checkUSDFCBalance: mocks.checkUSDFCBalance,
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
})
