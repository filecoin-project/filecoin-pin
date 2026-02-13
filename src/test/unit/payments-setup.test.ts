import { parseUnits } from '@filoz/synapse-sdk'
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
import { assertPriceNonZero } from '../../core/utils/validate-pricing.js'
import { parseStorageAllowance } from '../../payments/setup.js'

// Mock Synapse SDK
vi.mock('@filoz/synapse-sdk', () => {
  const mockSynapse = {
    getProvider: vi.fn(),
    getSigner: vi.fn(),
    getClient: vi.fn(),
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

  function parseUnits(value: string, decimals: number): bigint {
    const [db, da] = value.split('.')
    const intPart = db ?? '0'
    const fracPart = da?.padEnd(decimals, '0') ?? '0'.padStart(decimals, '0')
    return BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(fracPart)
  }

  function formatUnits(value: bigint, decimalsOrOpts: number | { decimals: number }): string {
    const decimals = typeof decimalsOrOpts === 'number' ? decimalsOrOpts : decimalsOrOpts.decimals
    const divisor = 10n ** BigInt(decimals)
    const int = value / divisor
    const frac = value % divisor
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '') || '0'
    return fracStr ? `${int}.${fracStr}` : String(int)
  }

  return {
    parseUnits,
    formatUnits,
    Synapse: {
      create: vi.fn().mockResolvedValue(mockSynapse),
    },
    TOKENS: {
      USDFC: 'USDFC',
      FIL: 'FIL',
    },
    TIME_CONSTANTS: {
      EPOCHS_PER_DAY: 2880n,
      EPOCHS_PER_MONTH: 86400n,
    },
    SIZE_CONSTANTS: {
      MIN_UPLOAD_SIZE: 127,
    },
    METADATA_KEYS: {
      WITH_IPFS_INDEXING: 'withIPFSIndexing',
      IPFS_ROOT_CID: 'ipfsRootCid',
    },
  }
})

describe('assertPriceNonZero', () => {
  it('throws when pricePerTiBPerEpoch is zero', () => {
    expect(() => assertPriceNonZero(0n)).toThrow('Invalid pricePerTiBPerEpoch: must be positive non-zero value')
  })

  it('throws when pricePerTiBPerEpoch is negative', () => {
    expect(() => assertPriceNonZero(-10n)).toThrow('Invalid pricePerTiBPerEpoch: must be positive non-zero value')
  })

  it('does not throw for positive price', () => {
    expect(() => assertPriceNonZero(1n)).not.toThrow()
  })
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
      getBalance: vi.fn().mockResolvedValue(parseUnits('5', 18)),
    }

    mockSigner = {
      getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
    }

    // Create mock Synapse instance
    const mockClient = {
      account: { address: '0x1234567890123456789012345678901234567890' },
      getAddress: mockSigner.getAddress,
    }
    mockSynapse = {
      getProvider: vi.fn().mockReturnValue(mockProvider),
      getSigner: vi.fn().mockReturnValue(mockSigner),
      getClient: vi.fn().mockReturnValue(mockClient),
      client: mockClient,
      getNetwork: vi.fn().mockReturnValue('calibration'),
      chain: {
        name: 'calibration',
        id: 314_159,
        contracts: {
          fwss: { address: '0xfwss' },
          filecoinPay: { address: '0xfilecoinPay' },
        },
      },
      getPaymentsAddress: vi.fn().mockReturnValue('0xpayments'),
      getWarmStorageAddress: vi.fn().mockReturnValue('0xwarmstorage'),
      payments: {
        walletBalance: vi
          .fn()
          .mockImplementation((opts: { token: string }) =>
            opts.token === 'FIL' ? Promise.resolve(parseUnits('5', 18)) : Promise.resolve(parseUnits('100', 18))
          ),
        balance: vi.fn().mockResolvedValue(parseUnits('10', 18)),
        serviceApproval: vi.fn().mockResolvedValue({
          rateAllowance: parseUnits('0.0001', 18),
          lockupAllowance: parseUnits('2', 18),
          rateUsed: 0n,
          lockupUsed: 0n,
        }),
        allowance: vi.fn().mockResolvedValue(parseUnits('0', 18)),
        depositWithPermitAndApproveOperator: vi
          .fn()
          .mockResolvedValue('0xdepositWithPermitAndApproveOperator' as `0x${string}`),
        deposit: vi.fn().mockResolvedValue('0xdeposit' as `0x${string}`),
        approveService: vi.fn().mockResolvedValue('0xservice' as `0x${string}`),
      },
      storage: {
        getStorageInfo: vi.fn().mockResolvedValue({
          pricing: {
            noCDN: {
              perTiBPerEpoch: parseUnits('0.00002893519', 18), // 2.5 USDFC/TiB/month
              perTiBPerDay: parseUnits('0.08333333', 18),
              perTiBPerMonth: parseUnits('2.5', 18),
            },
          },
        }),
      },
    }
  })

  describe('checkFILBalance', () => {
    it('should check FIL balance and network correctly', async () => {
      const result = await checkFILBalance(mockSynapse)

      expect(result.balance).toBe(parseUnits('5', 18))
      expect(result.isCalibnet).toBe(true)
      expect(result.hasSufficientGas).toBe(true)
    })

    it('should detect insufficient gas', async () => {
      mockSynapse.payments.walletBalance.mockImplementation((opts: { token: string }) =>
        opts.token === 'FIL' ? Promise.resolve(parseUnits('0.05', 18)) : Promise.resolve(parseUnits('100', 18))
      )

      const result = await checkFILBalance(mockSynapse)

      expect(result.hasSufficientGas).toBe(false)
    })
  })

  describe('checkUSDFCBalance', () => {
    it('should return USDFC wallet balance', async () => {
      const balance = await checkUSDFCBalance(mockSynapse)

      expect(balance).toBe(parseUnits('100', 18))
      expect(mockSynapse.payments.walletBalance).toHaveBeenCalledWith({ token: 'USDFC' })
    })
  })

  describe('getPaymentStatus', () => {
    it('should return complete payment status', async () => {
      const status = await getPaymentStatus(mockSynapse)

      expect(status.network).toBe('calibration')
      expect(status.address).toBe('0x1234567890123456789012345678901234567890')
      expect(status.filBalance).toBe(parseUnits('5', 18))
      expect(status.walletUsdfcBalance).toBe(parseUnits('100', 18))
      expect(status.filecoinPayBalance).toBe(parseUnits('10', 18))
      expect(status.currentAllowances.rateAllowance).toBe(parseUnits('0.0001', 18))
    })
  })

  describe('depositUSDFC', () => {
    it('should deposit USDFC without approval when allowance sufficient', async () => {
      mockSynapse.payments.allowance.mockResolvedValue(parseUnits('10', 18))

      const result = await depositUSDFC(mockSynapse, parseUnits('5', 18))

      expect(result.depositTx).toBe('0xdepositWithPermitAndApproveOperator')
      expect(mockSynapse.payments.depositWithPermitAndApproveOperator).toHaveBeenCalled()
    })

    it('should approve and deposit when allowance insufficient', async () => {
      mockSynapse.payments.allowance.mockResolvedValue(parseUnits('0', 18))

      const result = await depositUSDFC(mockSynapse, parseUnits('5', 18))

      expect(result.depositTx).toBe('0xdepositWithPermitAndApproveOperator')
      expect(mockSynapse.payments.depositWithPermitAndApproveOperator).toHaveBeenCalled()
    })
  })

  describe('setServiceApprovals', () => {
    it('should set service approvals with correct parameters', async () => {
      const rateAllowance = parseUnits('0.0001', 18)
      const lockupAllowance = parseUnits('2', 18)

      const txHash = await setServiceApprovals(mockSynapse, rateAllowance, lockupAllowance)

      expect(txHash).toBe('0xservice')
      expect(mockSynapse.payments.approveService).toHaveBeenCalledWith({
        service: '0xfwss',
        rateAllowance,
        lockupAllowance,
        maxLockupPeriod: 86400n, // 30 days * 2880 epochs/day (bigint)
        token: 'USDFC',
      })
    })
  })

  describe('calculateStorageAllowances', () => {
    it('should calculate allowances for 1 TiB/month', () => {
      const pricePerTiBPerEpoch = parseUnits('0.0000565', 18)
      const allowances = calculateStorageAllowances(1, pricePerTiBPerEpoch)

      expect(allowances.storageCapacityTiB).toBe(1)
      expect(allowances.rateAllowance).toBe(parseUnits('0.0000565', 18))
      expect(allowances.lockupAllowance).toBe(
        parseUnits('0.0000565', 18) * 2880n * 30n // rate * epochs/day * 30 days
      )
    })

    it('should calculate allowances for fractional TiB', () => {
      const pricePerTiBPerEpoch = parseUnits('0.0000565', 18)
      const allowances = calculateStorageAllowances(0.5, pricePerTiBPerEpoch)

      expect(allowances.storageCapacityTiB).toBe(0.5)
      // 0.5 TiB
      expect(allowances.rateAllowance).toBe(parseUnits('0.00002825', 18))
    })

    it('should calculate allowances for 1.5 TiB correctly', async () => {
      const pricePerTiBPerEpoch = parseUnits('0.0000565', 18)
      const allowances = calculateStorageAllowances(1.5, pricePerTiBPerEpoch)

      expect(allowances.storageCapacityTiB).toBe(1.5)
      // 1.5 TiB
      expect(allowances.rateAllowance).toBe(parseUnits('0.00008475', 18))
      expect(allowances.lockupAllowance).toBe(
        parseUnits('0.00008475', 18) * 2880n * 30n // rate * epochs/day * 30 days
      )
    })

    it('should calculate allowances for 1 GiB/month (small storage amount)', () => {
      const pricePerTiBPerEpoch = parseUnits('0.0000565', 18)
      const storageTiB = 1 / 1024 // 1 GiB = 1/1024 TiB ~= 0.0009765625 TiB
      const allowances = calculateStorageAllowances(storageTiB, pricePerTiBPerEpoch)

      expect(allowances.storageCapacityTiB).toBe(storageTiB)
      expect(allowances.rateAllowance).toBeGreaterThan(0n)
      expect(allowances.lockupAllowance).toBeGreaterThan(0n)

      const roundTripTiB = calculateActualCapacity(allowances.rateAllowance, pricePerTiBPerEpoch)
      expect(roundTripTiB).toBeCloseTo(storageTiB, 6)
    })

    it('should calculate allowances for 512 MiB/month', () => {
      const pricePerTiBPerEpoch = parseUnits('0.0000565', 18)
      const storageTiB = 512 / (1024 * 1024) // 512 MiB = 512/(1024*1024) TiB ~= 0.00048828125 TiB
      const allowances = calculateStorageAllowances(storageTiB, pricePerTiBPerEpoch)

      expect(allowances.storageCapacityTiB).toBe(storageTiB)
      expect(allowances.rateAllowance).toBeGreaterThan(0n)
      expect(allowances.lockupAllowance).toBeGreaterThan(0n)

      const roundTripTiB = calculateActualCapacity(allowances.rateAllowance, pricePerTiBPerEpoch)
      expect(roundTripTiB).toBeCloseTo(storageTiB, 6)
    })

    it('should calculate allowances for 1 MiB/month', () => {
      const pricePerTiBPerEpoch = parseUnits('0.0000565', 18)
      const storageTiB = 1 / (1024 * 1024) // 1 MiB in TiB
      const allowances = calculateStorageAllowances(storageTiB, pricePerTiBPerEpoch)

      expect(allowances.storageCapacityTiB).toBe(storageTiB)
      expect(allowances.rateAllowance).toBeGreaterThan(0n)
      expect(allowances.lockupAllowance).toBeGreaterThan(0n)

      const roundTripTiB = calculateActualCapacity(allowances.rateAllowance, pricePerTiBPerEpoch)
      expect(roundTripTiB).toBeCloseTo(storageTiB, 6)
    })

    it('should handle very large TiB values without overflow', () => {
      const pricePerTiBPerEpoch = parseUnits('0.0000565', 18)
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
      expect(formatUSDFC(parseUnits('1.2345', 18))).toBe('1.2345')
      expect(formatUSDFC(parseUnits('1.23456789', 18))).toBe('1.2346')
      expect(formatUSDFC(parseUnits('1000', 18))).toBe('1000.0000')
      expect(formatUSDFC(parseUnits('0.0001', 18), 6)).toBe('0.000100')
    })
  })

  describe('formatFIL', () => {
    it('should format FIL amounts with correct unit', () => {
      expect(formatFIL(parseUnits('1.5', 18), false)).toBe('1.5000 FIL')
      expect(formatFIL(parseUnits('1.5', 18), true)).toBe('1.5000 tFIL')
      expect(formatFIL(parseUnits('0.0001', 18), false)).toBe('0.0001 FIL')
    })
  })

  describe('calculateActualCapacity', () => {
    it('should calculate capacity from rate allowance with high precision', () => {
      const pricePerTiBPerEpoch = parseUnits('0.0000565', 18)
      const storageTiB = 1 / 1024 // 1 GiB/month
      const rateAllowance = calculateStorageAllowances(storageTiB, pricePerTiBPerEpoch).rateAllowance

      const capacityTiB = calculateActualCapacity(rateAllowance, pricePerTiBPerEpoch)

      const expectedTiB = 1 / 1024 // ~= 0.0009765625
      expect(capacityTiB).toBeCloseTo(expectedTiB, 5)
    })

    it('throws when pricePerTiBPerEpoch is zero', () => {
      expect(() => calculateActualCapacity(parseUnits('1', 18), 0n)).toThrow(
        'Invalid pricePerTiBPerEpoch: must be positive non-zero value'
      )
    })
  })

  describe('calculateStorageFromUSDFC', () => {
    it('should calculate storage capacity from USDFC amount with high precision', () => {
      const pricePerTiBPerEpoch = parseUnits('0.0000565', 18)
      // 30 days worth of 1GiB/month = 0.0047644416 USDFC
      const usdfcAmount = parseUnits('0.0047644416', 18)

      const capacityTiB = calculateStorageFromUSDFC(usdfcAmount, pricePerTiBPerEpoch)

      const expectedTiB = 1 / 1024 // ~= 0.0009765625
      expect(capacityTiB).toBeCloseTo(expectedTiB, 5)
    })

    it('throws when pricePerTiBPerEpoch is zero', () => {
      expect(() => calculateStorageFromUSDFC(parseUnits('1', 18), 0n)).toThrow(
        'Invalid pricePerTiBPerEpoch: must be positive non-zero value'
      )
    })

    it('returns 0 if usdfcAmount is 0', () => {
      const usdfcAmount = parseUnits('0', 18)
      const pricePerTiBPerEpoch = parseUnits('0.0005', 18)
      const capacityTiB = calculateStorageFromUSDFC(usdfcAmount, pricePerTiBPerEpoch)

      expect(capacityTiB).toBe(0)
    })

    // Verify pricePerTibPerEpoch needed to get 1TiB/month with 1USDFC given 30-day lockup
    // With 30-day lockup: 1 USDFC / (30 days * 2880 epochs/day) = 1 USDFC / 86400 epochs
    // For 1 TiB capacity: pricePerTiBPerEpoch = 1 / 86400 = 0.000011574074 USDFC
    it('should return capacity of 1 when pricePerTibPerEpoch is low', () => {
      const usdfcAmount = parseUnits('1', 18)
      const pricePerTiBPerEpoch = parseUnits('0.000011574074', 18)
      const capacityTiB = calculateStorageFromUSDFC(usdfcAmount, pricePerTiBPerEpoch)
      // within 10 decimal places accuracy of 1
      expect(capacityTiB).toBeCloseTo(1, 10)
    })

    it('should return lower capacity as pricePerTibPerEpoch increases', () => {
      const usdfcAmount = parseUnits('1', 18)
      const pricePerTiBPerEpoch = parseUnits('0.00005', 18)
      const capacityTiB = calculateStorageFromUSDFC(usdfcAmount, pricePerTiBPerEpoch)
      expect(calculateStorageFromUSDFC(usdfcAmount, pricePerTiBPerEpoch + parseUnits('0.00001', 18))).toBeLessThan(
        capacityTiB
      )
    })

    it('should return higher capacity as pricePerTibPerEpoch decreases', () => {
      const usdfcAmount = parseUnits('1', 18)
      const pricePerTiBPerEpoch = parseUnits('0.00005', 18)
      const capacityTiB = calculateStorageFromUSDFC(usdfcAmount, pricePerTiBPerEpoch)
      expect(calculateStorageFromUSDFC(usdfcAmount, pricePerTiBPerEpoch - parseUnits('0.00001', 18))).toBeGreaterThan(
        capacityTiB
      )
    })
  })
})
