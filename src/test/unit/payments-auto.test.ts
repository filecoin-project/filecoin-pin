import { parseUnits } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCheckAllowances,
  mockCheckAndSetAllowances,
  mockCheckFILBalance,
  mockCheckUSDFCBalance,
  mockComputeAutoSetupTargetBalance,
  mockDeposit,
  mockEnsureWallet,
  mockFetchSquidCatalog,
  mockGetPaymentStatus,
  mockInitialize,
  mockLogLine,
  mockParseCLIAuth,
  mockRecoverRemovedSource,
  mockReconcileReadyCheckpoint,
  mockResolveCatalogSource,
  mockValidateGasRequirement,
  mockValidatePaymentRequirements,
  mockVerifyResolvedErc20Source,
  mockCreateVerifiedResolvedSourceClient,
} = vi.hoisted(() => ({
  mockCheckAllowances: vi.fn(),
  mockCheckAndSetAllowances: vi.fn(),
  mockCheckFILBalance: vi.fn(),
  mockCheckUSDFCBalance: vi.fn(),
  mockComputeAutoSetupTargetBalance: vi.fn(),
  mockDeposit: vi.fn(),
  mockEnsureWallet: vi.fn(),
  mockFetchSquidCatalog: vi.fn(),
  mockGetPaymentStatus: vi.fn(),
  mockInitialize: vi.fn(),
  mockLogLine: vi.fn(),
  mockParseCLIAuth: vi.fn(),
  mockRecoverRemovedSource: vi.fn(),
  mockReconcileReadyCheckpoint: vi.fn(),
  mockResolveCatalogSource: vi.fn(),
  mockValidateGasRequirement: vi.fn(),
  mockValidatePaymentRequirements: vi.fn(),
  mockVerifyResolvedErc20Source: vi.fn(),
  mockCreateVerifiedResolvedSourceClient: vi.fn(),
}))

vi.mock('../../core/payments/acquisition/orchestrate.js', () => ({
  ensureWalletReadyForFilecoinTransactions: mockEnsureWallet,
  recoverRemovedSourceAcquisition: mockRecoverRemovedSource,
  reconcileReadyAcquisitionCheckpoint: mockReconcileReadyCheckpoint,
}))

vi.mock('../../core/payments/acquisition/execute.js', () => ({
  createVerifiedResolvedSourceClient: mockCreateVerifiedResolvedSourceClient,
  sourceAddressForPrivateKey: vi.fn(() => '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'),
}))

vi.mock('../../core/payments/acquisition/source-catalog.js', () => ({
  fetchSquidCatalog: mockFetchSquidCatalog,
  resolveCatalogSource: mockResolveCatalogSource,
  recoverySourceChainId: vi.fn((chain: string | undefined) => {
    const aliases: Record<string, number> = {
      arb: 42161,
      arbitrum: 42161,
      avalanche: 43114,
      avax: 43114,
      base: 8453,
      filecoin: 314,
      op: 10,
      optimism: 10,
    }
    return chain == null ? undefined : aliases[chain.toLowerCase()]
  }),
  sourceTokenIdentity: (source: { symbol: string; token: string; native: boolean }) =>
    source.native ? `${source.symbol} (native)` : `${source.symbol} (${source.token})`,
  verifyResolvedErc20Source: mockVerifyResolvedErc20Source,
}))

vi.mock('../../core/payments/index.js', () => ({
  MIN_FIL_FOR_GAS: 100n,
  calculateDepositCapacity: vi.fn(() => ({ gibPerMonth: 0 })),
  checkAllowances: mockCheckAllowances,
  checkAndSetAllowances: mockCheckAndSetAllowances,
  checkFILBalance: mockCheckFILBalance,
  checkUSDFCBalance: mockCheckUSDFCBalance,
  computeAutoSetupTargetBalance: mockComputeAutoSetupTargetBalance,
  depositUSDFC: mockDeposit,
  getPaymentStatus: mockGetPaymentStatus,
  validateGasRequirement: mockValidateGasRequirement,
  validatePaymentRequirements: mockValidatePaymentRequirements,
}))

vi.mock('../../core/synapse/index.js', () => ({
  getClientAddress: vi.fn(() => '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'),
  initializeSynapse: mockInitialize,
  mainnet: { id: 314 },
}))

vi.mock('../../utils/cli-auth.js', () => ({
  getCLILogger: vi.fn(() => ({})),
  parseCLIAuth: mockParseCLIAuth,
}))

vi.mock('../../utils/cli-helpers.js', () => ({
  cancel: vi.fn(),
  createSpinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  intro: vi.fn(),
  outro: vi.fn(),
}))

vi.mock('../../utils/cli-logger.js', () => ({
  log: { flush: vi.fn(), indent: vi.fn(), line: mockLogLine, message: vi.fn() },
}))

vi.mock('../../payments/setup.js', () => ({
  displayAccountInfo: vi.fn(),
  displayDepositWarning: vi.fn(),
}))

import { formatAutoSetupRetryCommand, runAutoSetup } from '../../payments/auto.js'

const TWO_USDFC = parseUnits('2', 18)
const AVALANCHE_USDC_SOURCE = {
  chain: { cliName: 'avalanche', chainId: 43114, aliases: ['avax'], nativeSymbol: 'AVAX', nativeDecimals: 18 },
  chainId: 43114,
  token: '0x1111111111111111111111111111111111111111',
  symbol: 'USDC',
  decimals: 6,
  native: false,
  display: 'USDC (0x1111111111111111111111111111111111111111)',
} as const
const FILECOIN_NATIVE_SOURCE = {
  chain: { cliName: 'filecoin', chainId: 314, aliases: [], nativeSymbol: 'FIL', nativeDecimals: 18 },
  chainId: 314,
  token: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  symbol: 'FIL',
  decimals: 18,
  native: true,
  display: 'FIL (native)',
} as const

function serializeErrorTree(value: unknown, seen = new Set<unknown>()): string {
  if (value == null || typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  const record = value as Record<string, unknown>
  return Object.getOwnPropertyNames(record)
    .sort()
    .map((key) => `${key}: ${serializeErrorTree(record[key], seen)}`)
    .join('\n')
}

function expectPostAcquisitionDirectRecovery(): void {
  expect(mockEnsureWallet).toHaveBeenCalledTimes(1)
  const output = mockLogLine.mock.calls.flat().join('\n')
  expect(output).toContain('Retry direct deposit:')
  expect(output).not.toContain('Retry source acquisition:')
  expect(output).not.toContain('--from-chain')
  expect(output).not.toContain('--from-token')
  expect(output).not.toContain('--max-source-amount')
}

describe('runAutoSetup acquisition integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockParseCLIAuth.mockReturnValue({
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
    })
    mockInitialize.mockResolvedValue({
      chain: { id: 314, name: 'mainnet' },
      payments: { accountSummary: vi.fn().mockResolvedValue({ availableFunds: 0n }) },
      storage: { getStorageInfo: vi.fn().mockResolvedValue({ pricing: { noCDN: { perTiBPerEpoch: 1n } } }) },
    })
    mockCheckFILBalance.mockResolvedValue({ balance: 0n, isCalibnet: false, hasSufficientGas: false })
    mockCheckUSDFCBalance.mockResolvedValue(0n)
    mockComputeAutoSetupTargetBalance.mockReturnValue({ requiredAvailableFunds: TWO_USDFC, targetBalance: TWO_USDFC })
    mockCheckAllowances.mockResolvedValue({ needsUpdate: true })
    mockGetPaymentStatus.mockReset()
    mockGetPaymentStatus
      .mockResolvedValueOnce({ filecoinPayBalance: 0n, filBalance: 0n, walletUsdfcBalance: 0n, currentAllowances: {} })
      .mockResolvedValueOnce({
        filecoinPayBalance: 0n,
        filBalance: 100n,
        walletUsdfcBalance: TWO_USDFC,
        currentAllowances: {},
      })
    mockValidatePaymentRequirements.mockReturnValue({ isValid: true })
    mockValidateGasRequirement.mockReturnValue({ isValid: true })
    mockEnsureWallet.mockResolvedValue([])
    mockRecoverRemovedSource.mockResolvedValue(undefined)
    mockReconcileReadyCheckpoint.mockResolvedValue(false)
    mockFetchSquidCatalog.mockResolvedValue({})
    mockResolveCatalogSource.mockReturnValue(AVALANCHE_USDC_SOURCE)
    mockCreateVerifiedResolvedSourceClient.mockResolvedValue({})
    mockVerifyResolvedErc20Source.mockImplementation(async (_client, source) => source)
    mockDeposit.mockResolvedValue({ depositTx: '0xdeposit' })
    mockCheckAndSetAllowances.mockResolvedValue({ updated: false })
  })

  it('keeps the explicit target and acquires wallet shortfalls before the existing deposit', async () => {
    const order: string[] = []
    mockEnsureWallet.mockImplementation(async () => {
      order.push('acquire')
      return []
    })
    mockDeposit.mockImplementation(async () => {
      order.push('deposit')
      return { depositTx: '0xdeposit' }
    })

    await expect(
      runAutoSetup({
        auto: true,
        deposit: '2',
        rateAllowance: '1TiB/month',
        fromChain: 'arb',
        fromToken: 'USDC',
        maxSourceAmount: '3',
        sourceRpcUrl: 'https://arb.example/rpc',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      } as any)
    ).resolves.toBeUndefined()

    expect(mockEnsureWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationChainId: 314,
        requiredUsdfc: TWO_USDFC,
        walletFilBalance: 0n,
        walletUsdfcBalance: 0n,
        resolvedSource: AVALANCHE_USDC_SOURCE,
      })
    )
    expect(mockDeposit).toHaveBeenCalledWith(expect.anything(), TWO_USDFC)
    expect(order).toEqual(['acquire', 'deposit'])
  })

  it('recovers an already-broadcast removed-source route without resolving a fresh catalog source', async () => {
    mockRecoverRemovedSource.mockResolvedValueOnce([
      {
        asset: 'usdfc',
        quoteId: 'recovered-base-route',
        sourceAmount: '1',
        sourceTransactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        status: 'confirmed',
      },
    ])

    await expect(
      runAutoSetup({
        auto: true,
        deposit: '2',
        rateAllowance: '1TiB/month',
        fromChain: 'base',
        fromToken: 'USDC',
        maxSourceAmount: '3',
        sourceRpcUrl: 'https://base.example/rpc',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      } as any)
    ).resolves.toBeUndefined()

    expect(mockRecoverRemovedSource).toHaveBeenCalledWith(
      expect.objectContaining({ destinationChainId: 314, fromChain: 'base', fromToken: 'USDC' })
    )
    expect(mockFetchSquidCatalog).not.toHaveBeenCalled()
    expect(mockResolveCatalogSource).not.toHaveBeenCalled()
    expect(mockEnsureWallet).not.toHaveBeenCalled()
    expect(mockDeposit).toHaveBeenCalledWith(expect.anything(), TWO_USDFC)
  })

  it('reconciles a removed-source approval after direct funding makes setup ready', async () => {
    mockCheckFILBalance.mockResolvedValueOnce({ balance: 100n, isCalibnet: false, hasSufficientGas: true })
    mockCheckUSDFCBalance.mockResolvedValueOnce(TWO_USDFC)
    mockRecoverRemovedSource.mockResolvedValueOnce([])

    await expect(
      runAutoSetup({
        auto: true,
        deposit: '2',
        rateAllowance: '1TiB/month',
        fromChain: 'base',
        fromToken: 'USDC',
        maxSourceAmount: '3',
        sourceRpcUrl: 'https://base.example/rpc',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      } as any)
    ).resolves.toBeUndefined()

    expect(mockRecoverRemovedSource).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationChainId: 314,
        fromChain: 'base',
        fromToken: 'USDC',
        allowMissingCheckpoint: true,
      })
    )
    expect(mockReconcileReadyCheckpoint).not.toHaveBeenCalled()
    expect(mockFetchSquidCatalog).not.toHaveBeenCalled()
    expect(mockEnsureWallet).not.toHaveBeenCalled()
    expect(mockDeposit).toHaveBeenCalledWith(expect.anything(), TWO_USDFC)
  })

  it('uses a verified non-Arbitrum ERC-20 source only after finding a shortfall', async () => {
    await expect(
      runAutoSetup({
        auto: true,
        deposit: '2',
        rateAllowance: '1TiB/month',
        fromChain: 'avalanche',
        fromToken: 'USDC',
        maxSourceAmount: '3',
        sourceRpcUrl: 'https://avalanche.example/rpc',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      })
    ).resolves.toBeUndefined()

    expect(mockFetchSquidCatalog).toHaveBeenCalledTimes(1)
    expect(mockResolveCatalogSource).toHaveBeenCalledWith({}, 'avalanche', 'USDC')
    expect(mockCreateVerifiedResolvedSourceClient).toHaveBeenCalledWith(
      AVALANCHE_USDC_SOURCE,
      'https://avalanche.example/rpc'
    )
    expect(mockEnsureWallet).toHaveBeenCalledWith(expect.objectContaining({ resolvedSource: AVALANCHE_USDC_SOURCE }))
  })

  it('passes a Filecoin native source to the shared reserve-aware acquisition flow', async () => {
    mockResolveCatalogSource.mockReturnValue(FILECOIN_NATIVE_SOURCE)

    await expect(
      runAutoSetup({
        auto: true,
        deposit: '2',
        rateAllowance: '1TiB/month',
        fromChain: 'filecoin',
        fromToken: 'native',
        maxSourceAmount: '3',
        sourceRpcUrl: 'https://filecoin-source.example/rpc',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      })
    ).resolves.toBeUndefined()

    expect(mockEnsureWallet).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedSource: FILECOIN_NATIVE_SOURCE, requiredUsdfc: TWO_USDFC })
    )
  })

  it('accepts a small 18-decimal source cap after resolving a Filecoin native source', async () => {
    mockResolveCatalogSource.mockReturnValue(FILECOIN_NATIVE_SOURCE)

    await expect(
      runAutoSetup({
        auto: true,
        deposit: '2',
        rateAllowance: '1TiB/month',
        fromChain: 'filecoin',
        fromToken: 'native',
        maxSourceAmount: '0.0000001',
        sourceRpcUrl: 'https://filecoin-source.example/rpc',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      })
    ).resolves.toBeUndefined()

    expect(mockEnsureWallet).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedSource: FILECOIN_NATIVE_SOURCE, maxSourceAmount: '0.0000001' })
    )
  })

  it('keeps the authoritative default target and deposit delta identical before deferred wallet readiness', async () => {
    const sourceOptions = {
      auto: true,
      rateAllowance: '1TiB/month',
      fromChain: 'arb',
      fromToken: 'USDC',
      maxSourceAmount: '3',
      sourceRpcUrl: 'https://arb.example/rpc',
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
    } as const
    const observed: Array<{ targetInput: unknown; deposited: bigint; acquisitionCalls: number }> = []

    mockCheckFILBalance.mockResolvedValue({ balance: 0n, isCalibnet: false, hasSufficientGas: false })
    mockCheckUSDFCBalance.mockResolvedValue(0n)
    mockGetPaymentStatus.mockReset()
    mockGetPaymentStatus
      .mockResolvedValueOnce({ filecoinPayBalance: 0n, filBalance: 0n, walletUsdfcBalance: 0n, currentAllowances: {} })
      .mockResolvedValueOnce({
        filecoinPayBalance: 0n,
        filBalance: 100n,
        walletUsdfcBalance: TWO_USDFC,
        currentAllowances: {},
      })
    await runAutoSetup(sourceOptions)
    observed.push({
      targetInput: mockComputeAutoSetupTargetBalance.mock.calls.at(-1)?.[0],
      deposited: mockDeposit.mock.calls.at(-1)?.[1] as bigint,
      acquisitionCalls: mockEnsureWallet.mock.calls.length,
    })

    mockEnsureWallet.mockClear()
    mockDeposit.mockClear()
    mockCheckFILBalance.mockResolvedValue({ balance: 100n, isCalibnet: false, hasSufficientGas: true })
    mockCheckUSDFCBalance.mockResolvedValue(TWO_USDFC)
    mockGetPaymentStatus.mockReset().mockResolvedValue({
      filecoinPayBalance: 0n,
      filBalance: 100n,
      walletUsdfcBalance: TWO_USDFC,
      currentAllowances: {},
    })
    await runAutoSetup(sourceOptions)
    observed.push({
      targetInput: mockComputeAutoSetupTargetBalance.mock.calls.at(-1)?.[0],
      deposited: mockDeposit.mock.calls.at(-1)?.[1] as bigint,
      acquisitionCalls: mockEnsureWallet.mock.calls.length,
    })

    expect(observed).toEqual([
      {
        targetInput: expect.objectContaining({ filecoinPayBalance: 0n, availableFunds: 0n }),
        deposited: TWO_USDFC,
        acquisitionCalls: 1,
      },
      {
        targetInput: expect.objectContaining({ filecoinPayBalance: 0n, availableFunds: 0n }),
        deposited: TWO_USDFC,
        acquisitionCalls: 0,
      },
    ])
  })

  it('does not acquire when the existing Filecoin Pay balance and allowances are sufficient', async () => {
    mockCheckFILBalance.mockResolvedValue({ balance: 0n, isCalibnet: false, hasSufficientGas: false })
    mockCheckUSDFCBalance.mockResolvedValue(0n)
    mockCheckAllowances.mockResolvedValue({ needsUpdate: false })
    mockGetPaymentStatus.mockReset().mockResolvedValue({
      filecoinPayBalance: TWO_USDFC,
      filBalance: 0n,
      walletUsdfcBalance: 0n,
      currentAllowances: {},
    })

    await expect(
      runAutoSetup({
        auto: true,
        deposit: '2',
        rateAllowance: '1TiB/month',
        fromChain: 'arb',
        fromToken: 'USDC',
        maxSourceAmount: '3',
      })
    ).resolves.toBeUndefined()

    expect(mockEnsureWallet).not.toHaveBeenCalled()
    expect(mockFetchSquidCatalog).not.toHaveBeenCalled()
    expect(mockCreateVerifiedResolvedSourceClient).not.toHaveBeenCalled()
    expect(mockDeposit).not.toHaveBeenCalled()
  })

  it('uses acquisition for an allowance-only FIL shortfall without requiring USDFC', async () => {
    mockCheckAllowances.mockResolvedValue({ needsUpdate: true })
    mockGetPaymentStatus.mockReset()
    mockGetPaymentStatus
      .mockResolvedValueOnce({
        filecoinPayBalance: TWO_USDFC,
        filBalance: 0n,
        walletUsdfcBalance: 0n,
        currentAllowances: {},
      })
      .mockResolvedValueOnce({
        filecoinPayBalance: TWO_USDFC,
        filBalance: 100n,
        walletUsdfcBalance: 0n,
        currentAllowances: {},
      })

    await expect(
      runAutoSetup({
        auto: true,
        deposit: '2',
        rateAllowance: '1TiB/month',
        fromChain: 'arb',
        fromToken: 'USDC',
        maxSourceAmount: '3',
        sourceRpcUrl: 'https://arb.example/rpc',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      })
    ).resolves.toBeUndefined()

    expect(mockEnsureWallet).toHaveBeenCalledWith(expect.objectContaining({ requiredUsdfc: 0n }))
    expect(mockDeposit).not.toHaveBeenCalled()
    expect(mockCheckAndSetAllowances).toHaveBeenCalled()
  })

  it('offers only direct payment recovery after a completed acquisition and failed deposit', async () => {
    mockDeposit.mockRejectedValueOnce(new Error('deposit failed'))

    await expect(
      runAutoSetup({
        auto: true,
        deposit: '2',
        rateAllowance: '1TiB/month',
        fromChain: 'arb',
        fromToken: 'USDC',
        maxSourceAmount: '3',
        sourceRpcUrl: 'https://arb.example/rpc',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      })
    ).rejects.toThrow('deposit failed')

    expectPostAcquisitionDirectRecovery()
    expect(mockDeposit).toHaveBeenCalledTimes(1)
    expect(mockCheckAndSetAllowances).not.toHaveBeenCalled()
  })

  it('offers only direct payment recovery after a completed acquisition and failed approval', async () => {
    mockGetPaymentStatus.mockReset()
    mockGetPaymentStatus
      .mockResolvedValueOnce({
        filecoinPayBalance: TWO_USDFC,
        filBalance: 0n,
        walletUsdfcBalance: 0n,
        currentAllowances: {},
      })
      .mockResolvedValueOnce({
        filecoinPayBalance: TWO_USDFC,
        filBalance: 100n,
        walletUsdfcBalance: 0n,
        currentAllowances: {},
      })
    mockCheckAndSetAllowances.mockRejectedValueOnce(new Error('approval failed'))

    await expect(
      runAutoSetup({
        auto: true,
        deposit: '2',
        rateAllowance: '1TiB/month',
        fromChain: 'arb',
        fromToken: 'USDC',
        maxSourceAmount: '3',
        sourceRpcUrl: 'https://arb.example/rpc',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      })
    ).rejects.toThrow('approval failed')

    expectPostAcquisitionDirectRecovery()
    expect(mockDeposit).not.toHaveBeenCalled()
    expect(mockCheckAndSetAllowances).toHaveBeenCalledTimes(1)
  })

  it('rejects a partial source selection before connecting or sending a transaction', async () => {
    await expect(
      runAutoSetup({ auto: true, deposit: '2', rateAllowance: '1TiB/month', fromChain: 'arb' })
    ).rejects.toThrow('Acquisition requires --from-chain, --from-token, and --max-source-amount together')

    expect(mockInitialize).not.toHaveBeenCalled()
    expect(mockEnsureWallet).not.toHaveBeenCalled()
    expect(mockDeposit).not.toHaveBeenCalled()
  })

  it.each([
    ['a non-positive source maximum', 'arb', 'USDC', '0', '--max-source-amount must be greater than zero'],
    ['an unsupported source route', 'unsupported', 'USDC', '1', 'Unsupported source chain: unsupported'],
  ])('validates %s before connecting even when setup would otherwise be a no-op', async (_description, fromChain, fromToken, maxSourceAmount, message) => {
    await expect(
      runAutoSetup({
        auto: true,
        deposit: '2',
        rateAllowance: '1TiB/month',
        fromChain,
        fromToken,
        maxSourceAmount,
      })
    ).rejects.toThrow(message)

    expect(mockInitialize).not.toHaveBeenCalled()
    expect(mockEnsureWallet).not.toHaveBeenCalled()
    expect(mockDeposit).not.toHaveBeenCalled()
    expect(mockCheckAndSetAllowances).not.toHaveBeenCalled()
  })

  it('fails before catalog or signing when an underfunded acquisition lacks a source RPC', async () => {
    await expect(
      runAutoSetup({
        auto: true,
        deposit: '2',
        rateAllowance: '1TiB/month',
        fromChain: 'avalanche',
        fromToken: 'USDC',
        maxSourceAmount: '3',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      })
    ).rejects.toThrow('Token acquisition requires --source-rpc-url or SOURCE_RPC_URL')

    expect(mockFetchSquidCatalog).not.toHaveBeenCalled()
    expect(mockEnsureWallet).not.toHaveBeenCalled()
    expect(mockDeposit).not.toHaveBeenCalled()
  })

  it('fails an ambiguous catalog selection before provider execution', async () => {
    mockResolveCatalogSource.mockImplementation(() => {
      throw new Error('Source token symbol USDC is ambiguous on avalanche; use an exact address')
    })

    await expect(
      runAutoSetup({
        auto: true,
        deposit: '2',
        rateAllowance: '1TiB/month',
        fromChain: 'avalanche',
        fromToken: 'USDC',
        maxSourceAmount: '3',
        sourceRpcUrl: 'https://avalanche.example/rpc',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      })
    ).rejects.toThrow('Source token symbol USDC is ambiguous on avalanche')

    expect(mockEnsureWallet).not.toHaveBeenCalled()
    expect(mockDeposit).not.toHaveBeenCalled()
  })

  it('fails closed on Calibration before invoking the mainnet acquisition provider', async () => {
    mockInitialize.mockResolvedValue({
      chain: { id: 314159, name: 'calibration' },
      payments: { accountSummary: vi.fn().mockResolvedValue({ availableFunds: 0n }) },
      storage: { getStorageInfo: vi.fn().mockResolvedValue({ pricing: { noCDN: { perTiBPerEpoch: 1n } } }) },
    })

    await expect(
      runAutoSetup({
        auto: true,
        deposit: '2',
        rateAllowance: '1TiB/month',
        fromChain: 'arb',
        fromToken: 'USDC',
        maxSourceAmount: '3',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      })
    ).rejects.toThrow('Token acquisition is available only on Filecoin mainnet')

    expect(mockEnsureWallet).not.toHaveBeenCalled()
    expect(mockDeposit).not.toHaveBeenCalled()
  })

  it('prioritizes Calibration acquisition guidance over read-only authentication validation', async () => {
    mockInitialize.mockResolvedValue({
      chain: { id: 314159, name: 'calibration' },
      payments: { accountSummary: vi.fn().mockResolvedValue({ availableFunds: 0n }) },
      storage: { getStorageInfo: vi.fn().mockResolvedValue({ pricing: { noCDN: { perTiBPerEpoch: 1n } } }) },
    })
    mockParseCLIAuth.mockReturnValueOnce({ readOnly: true })

    await expect(
      runAutoSetup({
        auto: true,
        deposit: '2',
        rateAllowance: '1TiB/month',
        fromChain: 'arb',
        fromToken: 'USDC',
        maxSourceAmount: '3',
      })
    ).rejects.toThrow('Token acquisition is available only on Filecoin mainnet')

    expect(mockEnsureWallet).not.toHaveBeenCalled()
    expect(mockDeposit).not.toHaveBeenCalled()
  })

  it('prioritizes Calibration acquisition guidance over a mismatched owner key', async () => {
    mockInitialize.mockResolvedValue({
      chain: { id: 314159, name: 'calibration' },
      payments: { accountSummary: vi.fn().mockResolvedValue({ availableFunds: 0n }) },
      storage: { getStorageInfo: vi.fn().mockResolvedValue({ pricing: { noCDN: { perTiBPerEpoch: 1n } } }) },
    })

    await expect(
      runAutoSetup({
        auto: true,
        deposit: '2',
        rateAllowance: '1TiB/month',
        fromChain: 'arb',
        fromToken: 'USDC',
        maxSourceAmount: '3',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000002',
      })
    ).rejects.toThrow('Token acquisition is available only on Filecoin mainnet')

    expect(mockEnsureWallet).not.toHaveBeenCalled()
    expect(mockDeposit).not.toHaveBeenCalled()
  })

  it('formats a recovery command with target and source bounds but no secrets', () => {
    const command = formatAutoSetupRetryCommand(
      {
        auto: true,
        deposit: '2',
        rateAllowance: '1TiB/month',
        fromChain: 'arb',
        fromToken: 'USDC',
        maxSourceAmount: '3',
        sourceRpcUrl: 'https://rpc.example/?api_key=secret',
        privateKey: 'private-key',
      },
      TWO_USDFC
    )

    expect(command).toContain("'--deposit' '2'")
    expect(command).toContain("'--from-chain' 'arb'")
    expect(command).toContain("'--max-source-amount' '3'")
    expect(command).not.toContain('rpc.example')
    expect(command).not.toContain('private-key')
  })

  it('formats recovery with the exact verified source identity', () => {
    const command = formatAutoSetupRetryCommand(
      {
        auto: true,
        deposit: '2',
        rateAllowance: '1TiB/month',
        fromChain: 'arb',
        fromToken: 'USDC',
        maxSourceAmount: '3',
      },
      TWO_USDFC,
      AVALANCHE_USDC_SOURCE
    )

    expect(command).toContain("'--from-chain' 'avalanche'")
    expect(command).toContain("'--from-token' '0x1111111111111111111111111111111111111111'")
  })

  it('sanitizes acquisition failures and prints a secret-free retry before any payment transaction', async () => {
    const sourceRpcUrl = 'https://arbitrum.example/rpc?apiKey=source-secret'
    const rpcUrl = 'https://filecoin.example/rpc?token=filecoin-secret'
    const privateKey = '0x0000000000000000000000000000000000000000000000000000000000000001'
    const publicHelpUrl = 'https://app.squidrouter.com/'
    const unconfiguredCredentialUrl = 'https://provider.example/rpc?access_key=unconfigured-secret'
    mockEnsureWallet.mockRejectedValueOnce(
      new Error(
        `Source RPC: ${sourceRpcUrl}\nDestination RPC: ${rpcUrl}\nPrivate key: ${privateKey}\nProvider: ${unconfiguredCredentialUrl}\nHelp: ${publicHelpUrl}`
      )
    )

    const failure = await runAutoSetup({
      auto: true,
      deposit: '2',
      rateAllowance: '1TiB/month',
      fromChain: 'arb',
      fromToken: 'USDC',
      maxSourceAmount: '3',
      sourceRpcUrl,
      rpcUrl,
      privateKey,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).not.toContain(sourceRpcUrl)
    expect((failure as Error).message).not.toContain(rpcUrl)
    expect((failure as Error).message).not.toContain(privateKey)
    expect((failure as Error).message).not.toContain(unconfiguredCredentialUrl)
    expect((failure as Error).message).toContain(publicHelpUrl)
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined()

    const serializedFailure = serializeErrorTree(failure)
    expect(serializedFailure).toContain(publicHelpUrl)
    expect(serializedFailure).not.toContain(sourceRpcUrl)
    expect(serializedFailure).not.toContain(rpcUrl)
    expect(serializedFailure).not.toContain(privateKey)
    expect(serializedFailure).not.toContain(unconfiguredCredentialUrl)
    expect(serializedFailure).not.toContain('source-secret')
    expect(serializedFailure).not.toContain('filecoin-secret')
    expect(serializedFailure).not.toContain('unconfigured-secret')
    expect(mockDeposit).not.toHaveBeenCalled()
    expect(mockCheckAndSetAllowances).not.toHaveBeenCalled()

    const output = mockLogLine.mock.calls.flat().join('\n')
    expect(output).toContain('Retry source acquisition:')
    expect(output).toContain("'--from-chain' 'avalanche'")
    expect(output).not.toContain(sourceRpcUrl)
    expect(output).not.toContain(rpcUrl)
    expect(output).not.toContain(privateKey)
    expect(output).not.toContain('source-secret')
    expect(output).not.toContain('filecoin-secret')
    expect(output).not.toContain('unconfigured-secret')
  })
})
