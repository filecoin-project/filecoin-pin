import { TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { parseEther } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  accountSummary: vi.fn(),
  cancel: vi.fn(),
  checkFILBalance: vi.fn(),
  checkUSDFCBalance: vi.fn(),
  log: { line: vi.fn(), indent: vi.fn(), flush: vi.fn() },
}))

vi.mock('../../core/synapse/index.js', () => ({
  initializeSynapse: vi.fn(async () => ({
    chain: { name: 'mainnet' },
    payments: { accountSummary: mocks.accountSummary },
  })),
  getClientAddress: vi.fn(() => '0x1234'),
}))
vi.mock('../../utils/cli-auth.js', () => ({
  parseCLIAuth: vi.fn(() => ({})),
  getCLILogger: vi.fn(() => ({})),
}))
vi.mock('../../utils/cli-helpers.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: mocks.cancel,
  createSpinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  formatFileSize: vi.fn(() => '0 B'),
}))
vi.mock('../../utils/cli-logger.js', () => ({
  log: mocks.log,
}))
vi.mock('../../core/payments/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/payments/index.js')>()),
  checkFILBalance: mocks.checkFILBalance,
  checkUSDFCBalance: mocks.checkUSDFCBalance,
}))
vi.mock('../../core/data-set/index.js', () => ({
  listDataSets: vi.fn(async () => []),
  calculateActualStorage: vi.fn(async () => ({ totalBytes: 0n, timedOut: false, warnings: [] })),
}))

import { deriveAccountStatus, formatFundedUntil, showPaymentStatus } from '../../payments/status.js'

const EPOCHS_14_DAYS = TIME_CONSTANTS.EPOCHS_PER_DAY * 14n

describe('deriveAccountStatus', () => {
  it('returns DEFICIT when runway is 0', () => {
    expect(deriveAccountStatus(0n, 0n)).toBe('DEFICIT')
  })

  it('returns DEFICIT when debt is positive', () => {
    expect(deriveAccountStatus(0n, 1n)).toBe('DEFICIT')
  })

  it('returns WARNING at exactly 14 days runway', () => {
    expect(deriveAccountStatus(EPOCHS_14_DAYS, 0n)).toBe('WARNING')
  })

  it('returns WARNING below 14 days runway', () => {
    expect(deriveAccountStatus(EPOCHS_14_DAYS - 1n, 0n)).toBe('WARNING')
  })

  it('returns HEALTHY above 14 days runway', () => {
    expect(deriveAccountStatus(EPOCHS_14_DAYS + 1n, 0n)).toBe('HEALTHY')
  })

  it('returns HEALTHY for very long runway', () => {
    expect(deriveAccountStatus(TIME_CONSTANTS.EPOCHS_PER_DAY * 365n, 0n)).toBe('HEALTHY')
  })
})

describe('formatFundedUntil', () => {
  it('returns no-spend message when lockup rate is 0', () => {
    expect(formatFundedUntil(9999n, 0n)).toBe('No active storage spend')
  })

  it('returns termination warning when runway is 0', () => {
    expect(formatFundedUntil(0n, 1n)).toBe('Providers may terminate service at any time')
  })

  it('returns indefinitely message for sentinel runway values', () => {
    expect(formatFundedUntil(BigInt(Number.MAX_SAFE_INTEGER), 1n)).toBe('Funded indefinitely')
  })

  describe('normal runway', () => {
    const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z').getTime()

    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(FIXED_NOW)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('formats 30-day runway with correct day count', () => {
      const runway = TIME_CONSTANTS.EPOCHS_PER_DAY * 30n
      const result = formatFundedUntil(runway, 1n)
      expect(result).toMatch(/^Funded until .+ {2}\(30 days\)$/)
    })

    it('formats 1-day runway with correct day count', () => {
      const runway = TIME_CONSTANTS.EPOCHS_PER_DAY * 1n
      const result = formatFundedUntil(runway, 1n)
      expect(result).toMatch(/^Funded until .+ {2}\(1 days\)$/)
    })

    it('truncates partial days in day count', () => {
      // 1.5 days worth of epochs → shows "1 days"
      const runway = (TIME_CONSTANTS.EPOCHS_PER_DAY * 3n) / 2n
      const result = formatFundedUntil(runway, 1n)
      expect(result).toContain('(1 days)')
    })
  })
})

describe('showPaymentStatus with zero wallet USDFC', () => {
  function summary(funds: bigint) {
    return {
      runwayInEpochs: TIME_CONSTANTS.EPOCHS_PER_DAY * 365n,
      debt: 0n,
      lockupRatePerEpoch: 1n,
      funds,
      availableFunds: funds,
      totalLockup: 0n,
      totalRateBasedLockup: 0n,
      totalFixedLockup: 0n,
    }
  }

  function loggedLines(): string[] {
    return [...mocks.log.line.mock.calls, ...mocks.log.indent.mock.calls].map((call) => String(call[0]))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.checkFILBalance.mockResolvedValue({
      balance: parseEther('1'),
      isCalibnet: false,
      hasSufficientGas: true,
    })
    mocks.checkUSDFCBalance.mockResolvedValue(0n)
  })

  it('completes without cancelling when all USDFC is held as deposits', async () => {
    // The #616 account shape: wallet USDFC 0, everything deposited.
    mocks.accountSummary.mockResolvedValue(summary(parseEther('36.7')))

    await showPaymentStatus({})

    expect(mocks.cancel).not.toHaveBeenCalled()
    expect(loggedLines().some((line) => line.includes('No USDFC in wallet'))).toBe(false)
  })

  it('shows acquisition links only when there is no USDFC anywhere', async () => {
    mocks.accountSummary.mockResolvedValue(summary(0n))

    await showPaymentStatus({})

    expect(mocks.cancel).not.toHaveBeenCalled()
    const lines = loggedLines()
    expect(lines.some((line) => line.includes('No USDFC in wallet'))).toBe(true)
    expect(lines.some((line) => line.includes('Bridge USDFC to Filecoin mainnet'))).toBe(true)
  })
})
