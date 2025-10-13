import { ethers } from 'ethers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  calculateActualCapacity,
  calculateStorageAllowances,
  calculateStorageFromUSDFC,
  checkFILBalance,
  checkUSDFCBalance,
  depositUSDFC,
  getPaymentStatus,
  setServiceApprovals,
} from '../../core/payments/index.js'
import { formatFIL, formatUSDFC } from '../../core/utils/format.js'
import { parseStorageAllowance } from '../../payments/setup.js'

// Mock Synapse SDK
vi.mock('@filoz/synapse-sdk', () => {
  const mockSynapse = {
    getProvider: vi.fn(),
    getSigner: vi.fn(),
    getNetwork: vi.fn(),
    getPaymentsAddress: vi.fn(),
    getWarmStorageAddress: vi.fn(),
    payments: {
      walletBalance: vi.fn(),
      balance: vi.fn(),
      serviceApproval: vi.fn(),
      allowance: vi.fn(),
      approve: vi.fn(),
      deposit: vi.fn(),
      approveService: vi.fn(),
    },
    storage: {
      getStorageInfo: vi.fn(),
    },
  }

  return {
    Synapse: {
      create: vi.fn().mockResolvedValue(mockSynapse),
    },
    TOKENS: {
      USDFC: 'USDFC',
    },
    TIME_CONSTANTS: {
      EPOCHS_PER_DAY: 2880n,
      EPOCHS_PER_MONTH: 86400n,
    },
    SIZE_CONSTANTS: {
      MIN_UPLOAD_SIZE: 127,
    },
  }
})

describe('Payment Setup Tests', () => {
  let mockSynapse: any
  let mockProvider: any
  let mockSigner: any

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks()

    // Create mock instances
    mockProvider = {
      getBalance: vi.fn().mockResolvedValue(ethers.parseEther('5')),
    }

    mockSigner = {
      getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
    }

    // Create mock Synapse instance
    mockSynapse = {
      getProvider: vi.fn().mockReturnValue(mockProvider),
      getSigner: vi.fn().mockReturnValue(mockSigner),
      getClient: vi.fn().mockReturnValue(mockSigner),
      getNetwork: vi.fn().mockReturnValue('calibration'),
      getPaymentsAddress: vi.fn().mockReturnValue('0xpayments'),
      getWarmStorageAddress: vi.fn().mockReturnValue('0xwarmstorage'),
      payments: {
        walletBalance: vi.fn().mockResolvedValue(ethers.parseUnits('100', 18)),
        balance: vi.fn().mockResolvedValue(ethers.parseUnits('10', 18)),
        serviceApproval: vi.fn().mockResolvedValue({
          rateAllowance: ethers.parseUnits('0.0001', 18),
          lockupAllowance: ethers.parseUnits('2', 18),
          rateUsed: 0n,
          lockupUsed: 0n,
        }),
        allowance: vi.fn().mockResolvedValue(ethers.parseUnits('0', 18)),
        approve: vi.fn().mockResolvedValue({
          wait: vi.fn(),
          hash: '0xapproval',
        }),
        deposit: vi.fn().mockResolvedValue({
          wait: vi.fn(),
          hash: '0xdeposit',
        }),
        approveService: vi.fn().mockResolvedValue({
          wait: vi.fn(),
          hash: '0xservice',
        }),
      },
      storage: {
        getStorageInfo: vi.fn().mockResolvedValue({
          pricing: {
            noCDN: {
              perTiBPerEpoch: ethers.parseUnits('0.0000565', 18),
              perTiBPerDay: ethers.parseUnits('0.16272', 18),
              perTiBPerMonth: ethers.parseUnits('4.8816', 18),
            },
          },
        }),
      },
    }
  })

  describe('checkFILBalance', () => {
    it('should check FIL balance and network correctly', async () => {
      const result = await checkFILBalance(mockSynapse)

      expect(result.balance).toBe(ethers.parseEther('5'))
      expect(result.isCalibnet).toBe(true)
      expect(result.hasSufficientGas).toBe(true)
    })

    it('should detect insufficient gas', async () => {
      mockProvider.getBalance.mockResolvedValue(ethers.parseEther('0.05'))

      const result = await checkFILBalance(mockSynapse)

      expect(result.hasSufficientGas).toBe(false)
    })
  })

  describe('checkUSDFCBalance', () => {
    it('should return USDFC wallet balance', async () => {
      const balance = await checkUSDFCBalance(mockSynapse)

      expect(balance).toBe(ethers.parseUnits('100', 18))
      expect(mockSynapse.payments.walletBalance).toHaveBeenCalledWith('USDFC')
    })
  })

  describe('getPaymentStatus', () => {
    it('should return complete payment status', async () => {
      const status = await getPaymentStatus(mockSynapse)

      expect(status.network).toBe('calibration')
      expect(status.address).toBe('0x1234567890123456789012345678901234567890')
      expect(status.filBalance).toBe(ethers.parseEther('5'))
      expect(status.usdfcBalance).toBe(ethers.parseUnits('100', 18))
      expect(status.depositedAmount).toBe(ethers.parseUnits('10', 18))
      expect(status.currentAllowances.rateAllowance).toBe(ethers.parseUnits('0.0001', 18))
    })
  })

  describe('depositUSDFC', () => {
    it('should deposit USDFC without approval when allowance sufficient', async () => {
      mockSynapse.payments.allowance.mockResolvedValue(ethers.parseUnits('10', 18))

      const result = await depositUSDFC(mockSynapse, ethers.parseUnits('5', 18))

      expect(result.approvalTx).toBeUndefined()
      expect(result.depositTx).toBe('0xdeposit')
      expect(mockSynapse.payments.approve).not.toHaveBeenCalled()
      expect(mockSynapse.payments.deposit).toHaveBeenCalled()
    })

    it('should approve and deposit when allowance insufficient', async () => {
      mockSynapse.payments.allowance.mockResolvedValue(ethers.parseUnits('0', 18))

      const result = await depositUSDFC(mockSynapse, ethers.parseUnits('5', 18))

      expect(result.approvalTx).toBe('0xapproval')
      expect(result.depositTx).toBe('0xdeposit')
      expect(mockSynapse.payments.approve).toHaveBeenCalled()
      expect(mockSynapse.payments.deposit).toHaveBeenCalled()
    })
  })

  describe('setServiceApprovals', () => {
    it('should set service approvals with correct parameters', async () => {
      const rateAllowance = ethers.parseUnits('0.0001', 18)
      const lockupAllowance = ethers.parseUnits('2', 18)

      const txHash = await setServiceApprovals(mockSynapse, rateAllowance, lockupAllowance)

      expect(txHash).toBe('0xservice')
      expect(mockSynapse.payments.approveService).toHaveBeenCalledWith(
        '0xwarmstorage',
        rateAllowance,
        lockupAllowance,
        28800n, // 10 days * 2880 epochs/day
        'USDFC'
      )
    })
  })

  describe('calculateStorageAllowances', () => {
    it('should calculate allowances for 1 TiB/month', () => {
      const pricePerTiBPerEpoch = ethers.parseUnits('0.0000565', 18)
      const allowances = calculateStorageAllowances(1, pricePerTiBPerEpoch)

      expect(allowances.storageCapacityTiB).toBe(1)
      expect(allowances.rateAllowance).toBe(ethers.parseUnits('0.0000565', 18))
      expect(allowances.lockupAllowance).toBe(
        ethers.parseUnits('0.0000565', 18) * 2880n * 10n // rate * epochs/day * 10 days
      )
    })

    it('should calculate allowances for fractional TiB', () => {
      const pricePerTiBPerEpoch = ethers.parseUnits('0.0000565', 18)
      const allowances = calculateStorageAllowances(0.5, pricePerTiBPerEpoch)

      expect(allowances.storageCapacityTiB).toBe(0.5)
      // 0.5 TiB
      expect(allowances.rateAllowance).toBe(ethers.parseUnits('0.00002825', 18))
    })

    it('should calculate allowances for 1.5 TiB correctly', async () => {
      const pricePerTiBPerEpoch = ethers.parseUnits('0.0000565', 18)
      const allowances = calculateStorageAllowances(1.5, pricePerTiBPerEpoch)

      expect(allowances.storageCapacityTiB).toBe(1.5)
      // 1.5 TiB
      expect(allowances.rateAllowance).toBe(ethers.parseUnits('0.00008475', 18))
      expect(allowances.lockupAllowance).toBe(
        ethers.parseUnits('0.00008475', 18) * 2880n * 10n // rate * epochs/day * 10 days
      )
    })

    it('should calculate allowances for 1 GiB/month (small storage amount)', () => {
      const pricePerTiBPerEpoch = ethers.parseUnits('0.0000565', 18)
      const storageTiB = 1 / 1024 // 1 GiB = 1/1024 TiB ~= 0.0009765625 TiB
      const allowances = calculateStorageAllowances(storageTiB, pricePerTiBPerEpoch)

      expect(allowances.storageCapacityTiB).toBe(storageTiB)
      expect(allowances.rateAllowance).toBeGreaterThan(0n)
      expect(allowances.lockupAllowance).toBeGreaterThan(0n)

      const roundTripTiB = calculateActualCapacity(allowances.rateAllowance, pricePerTiBPerEpoch)
      expect(roundTripTiB).toBeCloseTo(storageTiB, 6)
    })

    it('should calculate allowances for 512 MiB/month', () => {
      const pricePerTiBPerEpoch = ethers.parseUnits('0.0000565', 18)
      const storageTiB = 512 / (1024 * 1024) // 512 MiB = 512/(1024*1024) TiB ~= 0.00048828125 TiB
      const allowances = calculateStorageAllowances(storageTiB, pricePerTiBPerEpoch)

      expect(allowances.storageCapacityTiB).toBe(storageTiB)
      expect(allowances.rateAllowance).toBeGreaterThan(0n)
      expect(allowances.lockupAllowance).toBeGreaterThan(0n)

      const roundTripTiB = calculateActualCapacity(allowances.rateAllowance, pricePerTiBPerEpoch)
      expect(roundTripTiB).toBeCloseTo(storageTiB, 6)
    })

    it('should calculate allowances for 1 MiB/month', () => {
      const pricePerTiBPerEpoch = ethers.parseUnits('0.0000565', 18)
      const storageTiB = 1 / (1024 * 1024) // 1 MiB in TiB
      const allowances = calculateStorageAllowances(storageTiB, pricePerTiBPerEpoch)

      expect(allowances.storageCapacityTiB).toBe(storageTiB)
      expect(allowances.rateAllowance).toBeGreaterThan(0n)
      expect(allowances.lockupAllowance).toBeGreaterThan(0n)

      const roundTripTiB = calculateActualCapacity(allowances.rateAllowance, pricePerTiBPerEpoch)
      expect(roundTripTiB).toBeCloseTo(storageTiB, 6)
    })

    it('should handle very large TiB values without overflow', () => {
      const pricePerTiBPerEpoch = ethers.parseUnits('0.0000565', 18)
      // 900 billion TiB (if we multiplied this by STORAGE_SCALE_MAX, it would overflow)
      const storageTiB = 900_000_000_000

      const allowances = calculateStorageAllowances(storageTiB, pricePerTiBPerEpoch)

      // rateAllowance should be price * storageTiB exactly representable via bigint math
      const expectedRate = (pricePerTiBPerEpoch * BigInt(storageTiB)) / 1n
      expect(allowances.rateAllowance).toBe(expectedRate)
    })
  })

  describe('parseStorageAllowance', () => {
    it('should parse TiB/month format', () => {
      const tibPerMonth = parseStorageAllowance('2TiB/month')

      expect(tibPerMonth).toBe(2)
    })

    it('should parse GiB/month format', () => {
      const tibPerMonth = parseStorageAllowance('512GiB/month')

      expect(tibPerMonth).toBe(0.5)
    })

    it('should parse MiB/month format', () => {
      const tibPerMonth = parseStorageAllowance(`524288MiB/month`) // 512 GiB

      expect(tibPerMonth).toBe(0.5)
    })

    it('should return null for direct USDFC/epoch format', () => {
      const tibPerMonth = parseStorageAllowance('0.0001')

      expect(tibPerMonth).toBeNull()
    })

    it('should throw on invalid format', () => {
      expect(() => parseStorageAllowance('invalid')).toThrow()
    })
  })

  describe('formatUSDFC', () => {
    it('should format USDFC amounts correctly', () => {
      expect(formatUSDFC(ethers.parseUnits('1.2345', 18))).toBe('1.2345')
      expect(formatUSDFC(ethers.parseUnits('1.23456789', 18))).toBe('1.2346')
      expect(formatUSDFC(ethers.parseUnits('1000', 18))).toBe('1000.0000')
      expect(formatUSDFC(ethers.parseUnits('0.0001', 18), 6)).toBe('0.000100')
    })
  })

  describe('formatFIL', () => {
    it('should format FIL amounts with correct unit', () => {
      expect(formatFIL(ethers.parseEther('1.5'), false)).toBe('1.5000 FIL')
      expect(formatFIL(ethers.parseEther('1.5'), true)).toBe('1.5000 tFIL')
      expect(formatFIL(ethers.parseEther('0.0001'), false)).toBe('0.0001 FIL')
    })
  })

  describe('calculateActualCapacity', () => {
    it('should calculate capacity from rate allowance with high precision', () => {
      const pricePerTiBPerEpoch = ethers.parseUnits('0.0000565', 18)
      const storageTiB = 1 / 1024 // 1 GiB/month
      const rateAllowance = calculateStorageAllowances(storageTiB, pricePerTiBPerEpoch).rateAllowance

      const capacityTiB = calculateActualCapacity(rateAllowance, pricePerTiBPerEpoch)

      const expectedTiB = 1 / 1024 // ~= 0.0009765625
      expect(capacityTiB).toBeCloseTo(expectedTiB, 5)
    })

    it('should handle zero price gracefully', () => {
      const capacityTiB = calculateActualCapacity(ethers.parseUnits('1', 18), 0n)
      expect(capacityTiB).toBe(0)
    })
  })

  describe('calculateStorageFromUSDFC', () => {
    it('should calculate storage capacity from USDFC amount with high precision', () => {
      const pricePerTiBPerEpoch = ethers.parseUnits('0.0000565', 18)
      // 10 days worth of 1GiB/month = 0.0015881472 USDFC
      const usdfcAmount = ethers.parseUnits('0.0015881472', 18)

      const capacityTiB = calculateStorageFromUSDFC(usdfcAmount, pricePerTiBPerEpoch)

      const expectedTiB = 1 / 1024 // ~= 0.0009765625
      expect(capacityTiB).toBeCloseTo(expectedTiB, 5)
    })

    it('should handle zero price gracefully', () => {
      const capacityTiB = calculateStorageFromUSDFC(ethers.parseUnits('1', 18), 0n)
      expect(capacityTiB).toBe(0)
    })

    // FIXME: if pricePerTiBPerEpoch is 0, shouldn't we throw an error or return Infinity?
    // See https://github.com/filecoin-project/filecoin-pin/issues/38
    it('returns 0 if pricePerTiBPerEpoch is 0', () => {
      const usdfcAmount = ethers.parseUnits('1', 18)
      const pricePerTiBPerEpoch = ethers.parseUnits('0', 18)
      const capacityTiB = calculateStorageFromUSDFC(usdfcAmount, pricePerTiBPerEpoch)

      expect(capacityTiB).toBe(0)
    })

    it('returns 0 if usdfcAmount is 0', () => {
      const usdfcAmount = ethers.parseUnits('0', 18)
      const pricePerTiBPerEpoch = ethers.parseUnits('0.0005', 18)
      const capacityTiB = calculateStorageFromUSDFC(usdfcAmount, pricePerTiBPerEpoch)

      expect(capacityTiB).toBe(0)
    })

    // simple testcase to show what the pricePerTibPerEpoch would need to be to get 1TiB/month with 1USDFC
    // feel free to skip/delete this testcase if it becomes irrelevant
    it('should return capacity of 1 when pricePerTibPerEpoch is low', () => {
      const usdfcAmount = ethers.parseUnits('1', 18)
      const pricePerTiBPerEpoch = ethers.parseUnits('0.000034722219', 18)
      const capacityTiB = calculateStorageFromUSDFC(usdfcAmount, pricePerTiBPerEpoch)
      // within 10 decimal places accuracy of 1
      expect(capacityTiB).toBeCloseTo(1, 10)
    })

    it('should return lower capacity as pricePerTibPerEpoch increases', () => {
      const usdfcAmount = ethers.parseUnits('1', 18)
      const pricePerTiBPerEpoch = ethers.parseUnits('0.00005', 18)
      const capacityTiB = calculateStorageFromUSDFC(usdfcAmount, pricePerTiBPerEpoch)
      expect(
        calculateStorageFromUSDFC(usdfcAmount, pricePerTiBPerEpoch + ethers.parseUnits('0.00001', 18))
      ).toBeLessThan(capacityTiB)
    })

    it('should return higher capacity as pricePerTibPerEpoch decreases', () => {
      const usdfcAmount = ethers.parseUnits('1', 18)
      const pricePerTiBPerEpoch = ethers.parseUnits('0.00005', 18)
      const capacityTiB = calculateStorageFromUSDFC(usdfcAmount, pricePerTiBPerEpoch)
      expect(
        calculateStorageFromUSDFC(usdfcAmount, pricePerTiBPerEpoch - ethers.parseUnits('0.00001', 18))
      ).toBeGreaterThan(capacityTiB)
    })
  })
})
