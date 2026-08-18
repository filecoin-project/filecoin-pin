import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runFund } from '../../payments/fund.js'

const { mockAcquire, mockCalculate, mockConfirm, mockGetPaymentStatus, mockInitialize, mockInteractive, mockPlan } =
  vi.hoisted(() => ({
    mockAcquire: vi.fn(),
    mockCalculate: vi.fn(),
    mockConfirm: vi.fn(),
    mockGetPaymentStatus: vi.fn(),
    mockInitialize: vi.fn(),
    mockInteractive: vi.fn(() => true),
    mockPlan: vi.fn(),
  }))

vi.mock('@clack/prompts', () => ({ confirm: mockConfirm, isCancel: vi.fn(() => false) }))
vi.mock('../../core/synapse/index.js', () => ({
  getClientAddress: vi.fn(() => '0x1111111111111111111111111111111111111111'),
  initializeSynapse: mockInitialize,
  mainnet: { id: 314, contracts: { usdfc: { address: '0x80B98d3aa09ffff255c3ba4A241111Ff1262F045' } } },
}))
vi.mock('../../utils/cli-auth.js', () => ({
  parseCLIAuth: vi.fn(() => ({})),
  getCLILogger: vi.fn(() => ({})),
}))
vi.mock('../../utils/cli-helpers.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isInteractive: mockInteractive,
  createSpinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
}))
vi.mock('../../utils/cli-logger.js', () => ({
  isTTY: vi.fn(() => true),
  log: { line: vi.fn(), indent: vi.fn(), flush: vi.fn(), section: vi.fn() },
}))
vi.mock('../../core/payments/index.js', () => ({
  DEFAULT_LOCKUP_DAYS: 30,
  MIN_FIL_FOR_GAS: 100n,
  calculateFilecoinPayFundingPlan: mockCalculate,
  getPaymentStatus: mockGetPaymentStatus,
  planFilecoinPayFunding: mockPlan,
  checkUSDFCBalance: vi.fn(),
  depositUSDFC: vi.fn(),
  withdrawUSDFC: vi.fn(),
  clampDepositToLimit: vi.fn(),
  executeFilecoinPayFunding: vi.fn(),
  toStorageRunwaySummary: vi.fn(() => ({ state: 'no-spend' })),
}))
vi.mock('../../core/utils/format.js', () => ({ formatUSDFC: vi.fn((value: bigint) => String(value)) }))
vi.mock('../../core/utils/index.js', () => ({ formatRunwaySummary: vi.fn(() => ({ coverage: 'No spend' })) }))
vi.mock('../../payments/squid-funding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../payments/squid-funding.js')>()
  return { ...actual, acquirePaymentShortfalls: mockAcquire }
})

const sourceOptions = {
  amount: '1',
  fromChain: 'ethereum',
  fromToken: 'USDC',
  maxSourceAmount: '2',
  sourceRpcUrl: 'https://rpc.example',
  privateKey: `0x${'01'.padStart(64, '0')}`,
}

function refreshedPlan() {
  return {
    plan: {
      targetType: 'deposit',
      mode: 'exact',
      delta: 0n,
      targetDeposit: 1_000_000_000_000_000_000n,
      projected: { runway: { state: 'no-spend' }, depositedBalance: 1_000_000_000_000_000_000n },
      current: { runway: { rateUsed: 0n } },
    },
    status: { walletUsdfcBalance: 1_000_000_000_000_000_000n },
  }
}

describe('interactive Squid funding command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.exitCode = 0
    mockInteractive.mockReset().mockReturnValue(true)
    mockConfirm.mockReset().mockResolvedValue(true)
    mockInitialize.mockResolvedValue({
      chain: { id: 314 },
      payments: { accountSummary: vi.fn(async () => ({ funds: 0n })) },
    })
    mockGetPaymentStatus.mockResolvedValue({ filBalance: 90n, walletUsdfcBalance: 2n })
    mockCalculate.mockReturnValue({ delta: 10n, current: { spendRatePerEpoch: 1n } })
    mockPlan.mockResolvedValue(refreshedPlan())
    mockAcquire.mockImplementation(async (options) => {
      await options.confirm({
        source: { symbol: 'USDC', decimals: 6, chainId: 1 },
        sourceChainName: 'Ethereum',
        maxSourceAmount: 4_000_000n,
        maxNativeFee: 30_000_000_000_000_000n,
        nativeCurrency: { symbol: 'ETH', decimals: 18 },
        quotes: [
          {
            sourceAmount: 1_000_000n,
            requirement: { id: 'filecoin-fil', amount: options.filShortfall },
          },
          {
            sourceAmount: 2_000_000n,
            requirement: { id: 'filecoin-usdfc', amount: options.usdfcShortfall },
          },
        ],
      })
    })
  })

  it('buffers the wallet shortfall for one hour of spend, confirms, and replans after acquisition', async () => {
    await runFund(sourceOptions)

    expect(mockAcquire).toHaveBeenCalledWith(
      expect.objectContaining({
        filShortfall: 10n,
        usdfcShortfall: 128n,
        requiredWalletUsdfc: 130n,
        options: expect.objectContaining({ privateKey: sourceOptions.privateKey }),
      })
    )
    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Spend 3 USDC from Ethereum') })
    )
    expect(mockConfirm.mock.calls[0]?.[0].message).toContain('source-token limit: 4 USDC')
    expect(mockConfirm.mock.calls[0]?.[0].message).toContain(
      'buffered network-fee limit: 0.03 ETH; final network fees may vary'
    )
    expect(mockPlan).toHaveBeenCalledOnce()
  })

  it('does not enter the acquisition adapter when the planner reports no shortfall', async () => {
    mockGetPaymentStatus.mockResolvedValueOnce({ filBalance: 100n, walletUsdfcBalance: 10n })
    mockCalculate.mockReturnValueOnce({ delta: 0n, walletShortfall: 0n })
    mockInteractive.mockReturnValue(false)

    await runFund(sourceOptions)

    expect(mockAcquire).not.toHaveBeenCalled()
    expect(mockPlan).toHaveBeenCalledOnce()
  })

  it('requires an interactive terminal before contacting Squid', async () => {
    mockInteractive.mockReturnValueOnce(false)

    await expect(runFund(sourceOptions)).rejects.toThrow(/interactive terminal/)
    expect(mockInitialize).toHaveBeenCalledOnce()
    expect(mockAcquire).not.toHaveBeenCalled()
  })

  it('rejects incomplete source options before connecting', async () => {
    await expect(runFund({ amount: '1', fromChain: 'arbitrum' })).rejects.toThrow(/requires --from-chain/)
    expect(mockInitialize).not.toHaveBeenCalled()
  })

  it('treats declined source-spend confirmation as an incomplete operation', async () => {
    mockConfirm.mockResolvedValueOnce(false)

    await runFund(sourceOptions)

    expect(process.exitCode).toBe(2)
    expect(mockPlan).not.toHaveBeenCalled()
  })
})
