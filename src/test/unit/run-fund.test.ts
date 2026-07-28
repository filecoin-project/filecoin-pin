import { execFileSync } from 'node:child_process'
import { calibration } from '@filoz/synapse-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedSourceToken } from '../../core/payments/acquisition/source-catalog.js'
import { runFund } from '../../payments/fund.js'

const {
  mockConfirm,
  mockIsCancel,
  mockCancel,
  mockLogFlush,
  mockLogLine,
  mockLogSection,
  mockPlan,
  mockDeposit,
  mockWithdraw,
  mockGetPaymentStatus,
  mockInitialize,
  mockGetClientAddress,
  mockEnsureWallet,
  mockReconcileReadyCheckpoint,
  mockFetchCatalog,
  mockResolveCatalogSource,
  mockVerifyResolvedSource,
  mockCreateVerifiedSourceClient,
  mockParseCLIAuth,
} = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockIsCancel: vi.fn(() => false),
  mockCancel: vi.fn(),
  mockLogFlush: vi.fn(),
  mockLogLine: vi.fn(),
  mockLogSection: vi.fn(),
  mockPlan: vi.fn(),
  mockDeposit: vi.fn(),
  mockWithdraw: vi.fn(),
  mockGetPaymentStatus: vi.fn(),
  mockInitialize: vi.fn(async () => ({ chain: { id: 314 } })),
  mockGetClientAddress: vi.fn(() => '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'),
  mockEnsureWallet: vi.fn(),
  mockReconcileReadyCheckpoint: vi.fn(),
  mockFetchCatalog: vi.fn(),
  mockResolveCatalogSource: vi.fn(),
  mockVerifyResolvedSource: vi.fn(),
  mockCreateVerifiedSourceClient: vi.fn(),
  mockParseCLIAuth: vi.fn(() => ({})),
}))

vi.mock('@clack/prompts', () => ({
  confirm: mockConfirm,
  isCancel: mockIsCancel,
}))
vi.mock('../../core/synapse/index.js', () => ({
  initializeSynapse: mockInitialize,
  getClientAddress: mockGetClientAddress,
  mainnet: { id: 314 },
}))
vi.mock('../../core/payments/acquisition/orchestrate.js', () => ({
  ensureWalletReadyForFilecoinTransactions: mockEnsureWallet,
  reconcileReadyAcquisitionCheckpoint: mockReconcileReadyCheckpoint,
}))
vi.mock('../../core/payments/acquisition/source-catalog.js', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchSquidCatalog: mockFetchCatalog,
  resolveCatalogSource: mockResolveCatalogSource,
  verifyResolvedErc20Source: mockVerifyResolvedSource,
}))
vi.mock('../../core/payments/acquisition/execute.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createVerifiedResolvedSourceClient: mockCreateVerifiedSourceClient,
}))
vi.mock('../../utils/cli-auth.js', () => ({
  parseCLIAuth: mockParseCLIAuth,
  getCLILogger: vi.fn(() => ({})),
}))
vi.mock('../../utils/cli-helpers.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: mockCancel,
  isInteractive: vi.fn(() => true),
  createSpinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
}))
vi.mock('../../utils/cli-logger.js', () => ({
  isTTY: vi.fn(() => true),
  log: { line: mockLogLine, section: mockLogSection, indent: vi.fn(), flush: mockLogFlush },
}))
vi.mock('../../core/payments/index.js', () => ({
  DEFAULT_LOCKUP_DAYS: 30,
  MIN_FIL_FOR_GAS: 100_000_000_000_000_000n,
  planFilecoinPayFunding: mockPlan,
  checkUSDFCBalance: vi.fn(async () => 1_000_000_000_000_000_000_000n),
  depositUSDFC: mockDeposit,
  withdrawUSDFC: mockWithdraw,
  getPaymentStatus: mockGetPaymentStatus,
  clampDepositToLimit: vi.fn((v: bigint) => v),
  executeFilecoinPayFunding: vi.fn(),
  toStorageRunwaySummary: vi.fn(() => ({})),
}))
vi.mock('../../core/utils/format.js', () => ({
  formatUSDFC: vi.fn((v: bigint) => String(v)),
}))
vi.mock('../../core/utils/index.js', () => ({
  formatRunwaySummary: vi.fn(() => []),
}))

function planResult(delta: bigint) {
  return {
    plan: {
      targetType: 'deposit',
      mode: 'exact',
      delta,
      targetDeposit: delta > 0n ? delta : -delta,
      walletShortfall: null,
      projected: { runway: { state: 'active', runwayDays: 60 } },
      current: { runway: { rateUsed: 1n } },
    },
    status: { walletUsdfcBalance: 1_000_000_000_000_000_000_000n, filBalance: 1_000_000_000_000_000_000n },
  }
}

function underfundedPlan(delta: bigint) {
  const result = planResult(delta)
  result.status = { walletUsdfcBalance: 0n, filBalance: 0n }
  return result
}

function resolvedSource(chain = 'arbitrum', token = 'USDC', native = false): ResolvedSourceToken {
  const chainId = chain === 'base' ? 8453 : chain === 'filecoin' ? 314 : 42161
  const nativeSymbol = chain === 'filecoin' ? 'FIL' : 'ETH'
  return {
    chain: { cliName: chain, chainId, aliases: [], nativeSymbol, nativeDecimals: 18 },
    chainId,
    token: (native
      ? '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      : '0x1111111111111111111111111111111111111111') as `0x${string}`,
    symbol: native ? nativeSymbol : token,
    decimals: native ? 18 : 6,
    native,
    display: native ? `${nativeSymbol} (native)` : `${token} (0x1111111111111111111111111111111111111111)`,
  }
}

describe('runFund confirmation exit codes', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockIsCancel.mockReturnValue(false)
    mockInitialize.mockResolvedValue({
      chain: { id: 314 },
      payments: { accountSummary: vi.fn().mockResolvedValue({}) },
    } as never)
    mockGetClientAddress.mockReturnValue('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf')
    mockEnsureWallet.mockResolvedValue(undefined)
    mockGetPaymentStatus.mockResolvedValue({ filBalance: 0n, walletUsdfcBalance: 0n })
    mockFetchCatalog.mockResolvedValue({})
    mockResolveCatalogSource.mockImplementation((_catalog, chain, token) =>
      resolvedSource(chain === 'arb' ? 'arbitrum' : chain, token, token === 'native')
    )
    mockCreateVerifiedSourceClient.mockResolvedValue({})
    mockVerifyResolvedSource.mockImplementation(async (_client, source) => source)
    mockParseCLIAuth.mockReturnValue({})
    process.exitCode = 0
  })

  it('exits with code 2 when the deposit confirmation is declined', async () => {
    mockPlan.mockResolvedValueOnce(planResult(5_000_000_000_000_000_000n))
    mockConfirm.mockResolvedValueOnce(false)

    await runFund({ amount: '5' })

    expect(mockDeposit).not.toHaveBeenCalled()
    expect(mockCancel).toHaveBeenCalledWith('Deposit cancelled by user')
    expect(process.exitCode).toBe(2)
  })

  it('aborts the deposit when the confirmation prompt is cancelled', async () => {
    const cancelSymbol = Symbol('clack:cancel')
    mockPlan.mockResolvedValueOnce(planResult(5_000_000_000_000_000_000n))
    mockConfirm.mockResolvedValueOnce(cancelSymbol)
    mockIsCancel.mockReturnValueOnce(true)

    await runFund({ amount: '5' })

    expect(mockDeposit).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(2)
  })

  it('exits with code 2 when the withdraw confirmation is declined', async () => {
    mockPlan.mockResolvedValueOnce(planResult(-5_000_000_000_000_000_000n))
    mockConfirm.mockResolvedValueOnce(false)

    await runFund({ amount: '5' })

    expect(mockWithdraw).not.toHaveBeenCalled()
    expect(mockCancel).toHaveBeenCalledWith('Withdraw cancelled by user')
    expect(process.exitCode).toBe(2)
  })

  it('keeps a declined confirmation from downgrading a prior failure code', async () => {
    process.exitCode = 1
    mockPlan.mockResolvedValueOnce(planResult(5_000_000_000_000_000_000n))
    mockConfirm.mockResolvedValueOnce(false)

    await runFund({ amount: '5' })

    expect(process.exitCode).toBe(1)
  })

  it('fails closed on an RPC-resolved Calibration destination before source resolution', async () => {
    mockInitialize.mockResolvedValueOnce({ chain: { id: calibration.id } })
    mockPlan.mockResolvedValueOnce(underfundedPlan(5_000_000_000_000_000_000n))
    mockConfirm.mockResolvedValueOnce(false)

    await expect(
      runFund({
        amount: '5',
        rpcUrl: 'https://calibration.example/rpc',
        fromChain: 'arb',
        fromToken: 'USDC',
        maxSourceAmount: '10',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      })
    ).rejects.toThrow('Token acquisition is available only on Filecoin mainnet')

    expect(mockFetchCatalog).not.toHaveBeenCalled()
    expect(mockCreateVerifiedSourceClient).not.toHaveBeenCalled()
    expect(mockEnsureWallet).not.toHaveBeenCalled()
  })

  it.each([
    ['deposit', 5_000_000_000_000_000_000n, mockDeposit],
    ['withdraw', -5_000_000_000_000_000_000n, mockWithdraw],
  ])('keeps the direct %s path direct when Commander supplies SOURCE_RPC_URL', async (_operation, delta, adjustment) => {
    const synapse = {
      chain: { id: 314 },
      payments: { accountSummary: vi.fn().mockResolvedValue({ funds: 0n }) },
    }
    mockInitialize.mockResolvedValueOnce(synapse)
    mockPlan.mockResolvedValueOnce(planResult(delta))
    mockConfirm.mockResolvedValueOnce(true)
    mockDeposit.mockResolvedValueOnce({ depositTx: '0xdeposit' })
    mockWithdraw.mockResolvedValueOnce('0xwithdraw')

    await runFund({ amount: '5', sourceRpcUrl: 'https://ambient-source-rpc.example/rpc' })

    expect(mockPlan).toHaveBeenCalledWith(expect.objectContaining({ validateWalletReadiness: true }))
    expect(mockEnsureWallet).not.toHaveBeenCalled()
    expect(mockFetchCatalog).not.toHaveBeenCalled()
    expect(mockCreateVerifiedSourceClient).not.toHaveBeenCalled()
    expect(adjustment).toHaveBeenCalledWith(synapse, 5_000_000_000_000_000_000n)
  })

  it('keeps a newly funded wallet deposit direct when the planner snapshot is stale', async () => {
    const synapse = {
      chain: { id: 314 },
      payments: { accountSummary: vi.fn().mockResolvedValue({ funds: 0n }) },
    }
    mockInitialize.mockResolvedValueOnce(synapse)
    mockPlan.mockResolvedValueOnce(underfundedPlan(5_000_000_000_000_000_000n))
    mockGetPaymentStatus.mockResolvedValueOnce({
      filBalance: 1_000_000_000_000_000_000n,
      walletUsdfcBalance: 1_000_000_000_000_000_000_000n,
    })
    mockParseCLIAuth.mockReturnValueOnce({ readOnly: true })
    mockConfirm.mockResolvedValueOnce(true)
    mockDeposit.mockResolvedValueOnce({ depositTx: '0xdeposit' })

    await runFund({
      amount: '5',
      fromChain: 'base',
      fromToken: 'USDC',
      maxSourceAmount: '10',
      viewAddress: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
    })

    expect(mockDeposit).toHaveBeenCalledWith(synapse, 5_000_000_000_000_000_000n)
    expect(mockGetPaymentStatus).toHaveBeenCalledWith(synapse)
    expect(mockFetchCatalog).not.toHaveBeenCalled()
    expect(mockResolveCatalogSource).not.toHaveBeenCalled()
    expect(mockCreateVerifiedSourceClient).not.toHaveBeenCalled()
    expect(mockVerifyResolvedSource).not.toHaveBeenCalled()
    expect(mockEnsureWallet).not.toHaveBeenCalled()
  })

  it('reconciles a ready submitted acquisition locally without resolving a new source route', async () => {
    const synapse = {
      chain: { id: 314 },
      payments: { accountSummary: vi.fn().mockResolvedValue({ funds: 0n }) },
    }
    mockInitialize.mockResolvedValueOnce(synapse)
    mockPlan.mockResolvedValueOnce(underfundedPlan(5_000_000_000_000_000_000n))
    mockGetPaymentStatus.mockResolvedValueOnce({
      filBalance: 1_000_000_000_000_000_000n,
      walletUsdfcBalance: 1_000_000_000_000_000_000_000n,
    })
    mockReconcileReadyCheckpoint.mockResolvedValueOnce(true)
    mockConfirm.mockResolvedValueOnce(true)
    mockDeposit.mockResolvedValueOnce({ depositTx: '0xdeposit' })

    await runFund({
      amount: '5',
      fromChain: 'base',
      fromToken: 'USDC',
      maxSourceAmount: '10',
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
    })

    expect(mockReconcileReadyCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationOwner: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
        destinationChainId: 314,
        walletFilBalance: 1_000_000_000_000_000_000n,
        walletUsdfcBalance: 1_000_000_000_000_000_000_000n,
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
        fromChain: 'base',
        fromToken: 'USDC',
      })
    )
    expect(mockFetchCatalog).not.toHaveBeenCalled()
    expect(mockCreateVerifiedSourceClient).not.toHaveBeenCalled()
    expect(mockEnsureWallet).not.toHaveBeenCalled()
    expect(mockDeposit).toHaveBeenCalledWith(synapse, 5_000_000_000_000_000_000n)
  })

  it('blocks a ready retry with a pending checkpoint owned by a different Filecoin wallet', async () => {
    const sessionOwner = '0x1111111111111111111111111111111111111111'
    const checkpointOwnerKey = '0x0000000000000000000000000000000000000000000000000000000000000001'
    const synapse = {
      chain: { id: 314 },
      payments: { accountSummary: vi.fn().mockResolvedValue({ funds: 0n }) },
    }
    mockInitialize.mockResolvedValueOnce(synapse)
    mockGetClientAddress.mockReturnValueOnce(sessionOwner)
    mockPlan.mockResolvedValueOnce(underfundedPlan(5_000_000_000_000_000_000n))
    mockGetPaymentStatus.mockResolvedValueOnce({
      filBalance: 1_000_000_000_000_000_000n,
      walletUsdfcBalance: 1_000_000_000_000_000_000_000n,
    })
    mockReconcileReadyCheckpoint.mockRejectedValueOnce(
      new Error('Acquisition private key must control the configured Filecoin wallet owner')
    )

    await expect(
      runFund({
        amount: '5',
        fromChain: 'base',
        fromToken: 'USDC',
        maxSourceAmount: '10',
        viewAddress: sessionOwner,
        privateKey: checkpointOwnerKey,
      })
    ).rejects.toThrow('Acquisition private key must control the configured Filecoin wallet owner')

    expect(mockReconcileReadyCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ destinationOwner: sessionOwner, privateKey: checkpointOwnerKey })
    )
    expect(mockDeposit).not.toHaveBeenCalled()
    expect(mockFetchCatalog).not.toHaveBeenCalled()
    expect(mockCreateVerifiedSourceClient).not.toHaveBeenCalled()
  })

  it('keeps a ready no-checkpoint retry direct when the session wallet and supplied private key differ', async () => {
    const sessionOwner = '0x1111111111111111111111111111111111111111'
    const checkpointOwnerKey = '0x0000000000000000000000000000000000000000000000000000000000000001'
    const synapse = {
      chain: { id: 314 },
      payments: { accountSummary: vi.fn().mockResolvedValue({ funds: 0n }) },
    }
    mockInitialize.mockResolvedValueOnce(synapse)
    mockGetClientAddress.mockReturnValueOnce(sessionOwner)
    mockPlan.mockResolvedValueOnce(underfundedPlan(5_000_000_000_000_000_000n))
    mockGetPaymentStatus.mockResolvedValueOnce({
      filBalance: 1_000_000_000_000_000_000n,
      walletUsdfcBalance: 1_000_000_000_000_000_000_000n,
    })
    mockReconcileReadyCheckpoint.mockResolvedValueOnce(false)
    mockConfirm.mockResolvedValueOnce(true)
    mockDeposit.mockResolvedValueOnce({ depositTx: '0xdeposit' })

    await runFund({
      amount: '5',
      fromChain: 'base',
      fromToken: 'USDC',
      maxSourceAmount: '10',
      viewAddress: sessionOwner,
      privateKey: checkpointOwnerKey,
    })

    expect(mockReconcileReadyCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationOwner: sessionOwner,
        destinationChainId: 314,
        walletFilBalance: 1_000_000_000_000_000_000n,
        walletUsdfcBalance: 1_000_000_000_000_000_000_000n,
        privateKey: checkpointOwnerKey,
        fromChain: 'base',
        fromToken: 'USDC',
      })
    )
    expect(mockDeposit).toHaveBeenCalledWith(synapse, 5_000_000_000_000_000_000n)
    expect(mockFetchCatalog).not.toHaveBeenCalled()
    expect(mockCreateVerifiedSourceClient).not.toHaveBeenCalled()
    expect(mockEnsureWallet).not.toHaveBeenCalled()
  })

  it('uses source RPC and slippage only when the complete acquisition tuple is present', async () => {
    mockPlan.mockResolvedValueOnce(underfundedPlan(5_000_000_000_000_000_000n))
    mockConfirm.mockResolvedValueOnce(false)

    await runFund({
      amount: '5',
      fromChain: 'arb',
      fromToken: 'USDC',
      maxSourceAmount: '10',
      sourceRpcUrl: 'https://ambient-source-rpc.example/rpc',
      slippage: 1,
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
    })

    expect(mockEnsureWallet).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRpcUrl: 'https://ambient-source-rpc.example/rpc', slippage: 1 })
    )
    expect(mockFetchCatalog).toHaveBeenCalledTimes(1)
    expect(mockResolveCatalogSource).toHaveBeenCalledWith({}, 'arb', 'USDC')
    expect(mockCreateVerifiedSourceClient).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 42161, symbol: 'USDC' }),
      'https://ambient-source-rpc.example/rpc'
    )
    expect(mockEnsureWallet).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedSource: expect.objectContaining({ chainId: 42161, decimals: 6 }) })
    )
  })

  it('fails visibly before catalog or provider work when an underfunded acquisition has no source RPC', async () => {
    mockPlan.mockResolvedValueOnce(underfundedPlan(5_000_000_000_000_000_000n))

    await expect(
      runFund({
        amount: '5',
        fromChain: 'base',
        fromToken: 'USDC',
        maxSourceAmount: '20',
      })
    ).rejects.toThrow('Token acquisition requires --source-rpc-url or SOURCE_RPC_URL')

    expect(mockLogLine).toHaveBeenCalledWith(
      expect.stringContaining('Token acquisition requires --source-rpc-url or SOURCE_RPC_URL')
    )
    expect(mockFetchCatalog).not.toHaveBeenCalled()
    expect(mockResolveCatalogSource).not.toHaveBeenCalled()
    expect(mockCreateVerifiedSourceClient).not.toHaveBeenCalled()
    expect(mockVerifyResolvedSource).not.toHaveBeenCalled()
    expect(mockEnsureWallet).not.toHaveBeenCalled()
    expect(mockDeposit).not.toHaveBeenCalled()
  })

  it('fails visibly before catalog or provider work when an underfunded acquisition has no private key', async () => {
    mockPlan.mockResolvedValueOnce(underfundedPlan(5_000_000_000_000_000_000n))

    await expect(
      runFund({
        amount: '5',
        fromChain: 'base',
        fromToken: 'USDC',
        maxSourceAmount: '20',
        sourceRpcUrl: 'https://base.example/rpc',
      })
    ).rejects.toThrow('Token acquisition requires --private-key for source transactions')

    expect(mockLogLine).toHaveBeenCalledWith(
      expect.stringContaining('Token acquisition requires --private-key for source transactions')
    )
    expect(mockFetchCatalog).not.toHaveBeenCalled()
    expect(mockResolveCatalogSource).not.toHaveBeenCalled()
    expect(mockCreateVerifiedSourceClient).not.toHaveBeenCalled()
    expect(mockVerifyResolvedSource).not.toHaveBeenCalled()
    expect(mockEnsureWallet).not.toHaveBeenCalled()
    expect(mockDeposit).not.toHaveBeenCalled()
  })

  it('integrates a unique Base ERC-20 source with its dynamic decimals', async () => {
    const baseUsdc = resolvedSource('base', 'USDC')
    mockResolveCatalogSource.mockReturnValueOnce(baseUsdc)
    mockPlan.mockResolvedValueOnce(underfundedPlan(5_000_000_000_000_000_000n))
    mockConfirm.mockResolvedValueOnce(false)

    await runFund({
      amount: '5',
      fromChain: 'base',
      fromToken: 'USDC',
      maxSourceAmount: '20',
      sourceRpcUrl: 'https://base.example/rpc',
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
    })

    expect(mockResolveCatalogSource).toHaveBeenCalledWith({}, 'base', 'USDC')
    expect(mockEnsureWallet).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedSource: baseUsdc, maxSourceAmount: '20' })
    )
  })

  it.each([
    ['exact address', 'base', '0x2222222222222222222222222222222222222222', resolvedSource('base', 'USDC')],
    ['native token', 'base', 'native', resolvedSource('base', 'ETH', true)],
    ['Filecoin same-chain', 'filecoin', 'USDFC', resolvedSource('filecoin', 'USDFC')],
  ])('passes the resolved %s identity to the shared executor', async (_label, chain, token, source) => {
    mockResolveCatalogSource.mockReturnValueOnce(source)
    mockPlan.mockResolvedValueOnce(underfundedPlan(5_000_000_000_000_000_000n))
    mockConfirm.mockResolvedValueOnce(false)

    await runFund({
      amount: '5',
      fromChain: chain,
      fromToken: token,
      maxSourceAmount: '20',
      sourceRpcUrl: 'https://selected.example/rpc',
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
    })

    expect(mockEnsureWallet).toHaveBeenCalledWith(expect.objectContaining({ resolvedSource: source }))
  })

  it('stops an ambiguous source symbol before provider or source execution', async () => {
    mockPlan.mockResolvedValueOnce(underfundedPlan(5_000_000_000_000_000_000n))
    mockResolveCatalogSource.mockImplementationOnce(() => {
      throw new Error('Source token symbol USDC is ambiguous on base; use one of: 0x1, 0x2')
    })

    await expect(
      runFund({
        amount: '5',
        fromChain: 'base',
        fromToken: 'USDC',
        maxSourceAmount: '20',
        sourceRpcUrl: 'https://base.example/rpc',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      })
    ).rejects.toThrow('ambiguous on base')

    expect(mockCreateVerifiedSourceClient).not.toHaveBeenCalled()
    expect(mockEnsureWallet).not.toHaveBeenCalled()
  })

  it('stops a selected-source RPC chain mismatch before provider execution', async () => {
    mockPlan.mockResolvedValueOnce(underfundedPlan(5_000_000_000_000_000_000n))
    mockVerifyResolvedSource.mockRejectedValueOnce(
      new Error('Source RPC chain ID 1 does not match selected source chain ID 8453')
    )

    await expect(
      runFund({
        amount: '5',
        fromChain: 'base',
        fromToken: 'USDC',
        maxSourceAmount: '20',
        sourceRpcUrl: 'https://base.example/rpc',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      })
    ).rejects.toThrow('does not match selected source chain ID 8453')

    expect(mockEnsureWallet).not.toHaveBeenCalled()
  })

  it('keeps normal gas validation before a source-configured withdrawal can confirm or broadcast', async () => {
    mockPlan.mockRejectedValueOnce(new Error('Insufficient FIL for gas fees'))

    await expect(
      runFund({
        amount: '5',
        fromChain: 'arb',
        fromToken: 'USDC',
        maxSourceAmount: '10',
        sourceRpcUrl: 'https://ambient-source-rpc.example/rpc',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      })
    ).rejects.toThrow('Insufficient FIL for gas fees')

    expect(mockPlan).toHaveBeenCalledWith(
      expect.objectContaining({ validateWalletReadiness: true, deferWalletReadinessForPositiveDelta: true })
    )
    expect(mockEnsureWallet).not.toHaveBeenCalled()
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(mockWithdraw).not.toHaveBeenCalled()
  })

  it('keeps direct Calibration wallet shortfalls out of the acquisition helper', async () => {
    const basePlan = planResult(5_000_000_000_000_000_000n)
    const planned = {
      ...basePlan,
      plan: { ...basePlan.plan, walletShortfall: basePlan.plan.delta },
      status: { walletUsdfcBalance: 0n, filBalance: 100_000_000_000_000_000n },
    }
    mockInitialize.mockResolvedValueOnce({ chain: { id: calibration.id } })
    mockPlan.mockResolvedValueOnce(planned)

    await expect(runFund({ amount: '5', network: 'calibration' })).rejects.toThrow(
      'Insufficient USDFC in wallet (need 5000000000000000000 USDFC, have 0 USDFC)'
    )

    expect(mockEnsureWallet).not.toHaveBeenCalled()
    expect(mockDeposit).not.toHaveBeenCalled()
  })

  it('exits with code 2 when an interactive source acquisition is declined before execution', async () => {
    mockPlan.mockResolvedValueOnce(underfundedPlan(5_000_000_000_000_000_000n))
    mockEnsureWallet.mockImplementationOnce(
      async (options: {
        confirmSourceAcquisition?: (summary: {
          sourceAmount: bigint
          maxSourceAmount: bigint
          nativeCommitment?: bigint
          maxNativeGas?: bigint
          legs: Array<{ asset: 'fil' | 'usdfc'; minimumDestinationAmount: bigint; expiresAt: number }>
        }) => Promise<void>
      }) => {
        if (options.confirmSourceAcquisition == null)
          throw new Error('expected source acquisition confirmation callback')
        await options.confirmSourceAcquisition({
          sourceAmount: 1_000_000n,
          maxSourceAmount: 10_000_000n,
          nativeCommitment: 1_234_000_000_000_000_000n,
          maxNativeGas: 2_500_000_000_000_000_000n,
          legs: [{ asset: 'usdfc', minimumDestinationAmount: 1_000_000_000_000_000_000n, expiresAt: 2_000_000_000 }],
        })
      }
    )
    mockConfirm.mockResolvedValueOnce(false)

    await runFund({
      amount: '5',
      fromChain: 'arb',
      fromToken: 'USDC',
      maxSourceAmount: '10',
      sourceRpcUrl: 'https://arbitrum.example/rpc',
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
    })

    expect(mockEnsureWallet).toHaveBeenCalledTimes(1)
    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('1 USDC (0x1111111111111111111111111111111111111111)'),
      })
    )
    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('quoted route-native commitment 1.234; ceiling 2.5 ETH'),
      })
    )
    expect(mockDeposit).not.toHaveBeenCalled()
    expect(mockCancel).toHaveBeenCalledWith('Source acquisition cancelled by user')
    expect(process.exitCode).toBe(2)
  })

  it('reports exact shortfalls, a sanitized fallback, and a repeatable resume command after acquisition failure', async () => {
    const planned = planResult(5_000_000_000_000_000_000n)
    planned.status = { walletUsdfcBalance: 0n, filBalance: 0n }
    mockPlan.mockResolvedValueOnce(planned)
    mockEnsureWallet.mockRejectedValueOnce(new Error('Squid quote failed (429)'))

    await expect(
      runFund({
        amount: '5',
        fromChain: 'arb',
        fromToken: 'USDC',
        maxSourceAmount: '10',
        sourceRpcUrl: 'https://arbitrum.example/rpc',
        rpcUrl: 'https://filecoin.example/rpc',
        mode: 'minimum',
        slippage: 1,
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      })
    ).rejects.toThrow(
      'Source: arbitrum (42161), USDC (0x1111111111111111111111111111111111111111), 6 decimals. Remaining wallet shortfalls: FIL 0.1, USDFC 5. Squid fallback: https://app.squidrouter.com/'
    )
    expect(mockLogLine).toHaveBeenCalledWith(
      expect.stringContaining(
        "'filecoin-pin' 'payments' 'fund' '--amount' '5' '--from-chain' 'arbitrum' '--from-token' '0x1111111111111111111111111111111111111111' '--max-source-amount' '10' '--mode' 'minimum' '--slippage' '1'"
      )
    )
    expect(mockLogLine).toHaveBeenCalledWith(expect.stringContaining('SOURCE_RPC_URL and RPC_URL'))
    expect(mockLogLine.mock.calls.flat().join('\n')).not.toContain('https://arbitrum.example/rpc')
    expect(mockLogLine.mock.calls.flat().join('\n')).not.toContain('https://filecoin.example/rpc')
  })

  it('keeps the native marker in a source-acquisition retry command', async () => {
    const planned = planResult(5_000_000_000_000_000_000n)
    planned.status = { walletUsdfcBalance: 0n, filBalance: 0n }
    mockPlan.mockResolvedValueOnce(planned)
    mockEnsureWallet.mockRejectedValueOnce(new Error('Squid quote failed (429)'))

    await expect(
      runFund({
        amount: '5',
        fromChain: 'base',
        fromToken: 'native',
        maxSourceAmount: '10',
        sourceRpcUrl: 'https://base.example/rpc',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      })
    ).rejects.toThrow('Source: base (8453), ETH (native), 18 decimals. Remaining wallet shortfalls')

    const output = mockLogLine.mock.calls.flat().join('\n')
    expect(output).toContain("'--from-chain' 'base' '--from-token' 'native'")
    expect(output).not.toContain('https://base.example/rpc')
  })

  it('rejects acquisition before provider work when its private key does not own the Synapse wallet', async () => {
    const planned = planResult(5_000_000_000_000_000_000n)
    planned.status = { walletUsdfcBalance: 0n, filBalance: 0n }
    mockPlan.mockResolvedValueOnce(planned)
    mockGetClientAddress.mockReturnValueOnce('0x0000000000000000000000000000000000000002')

    await expect(
      runFund({
        amount: '5',
        fromChain: 'arb',
        fromToken: 'USDC',
        maxSourceAmount: '10',
        sourceRpcUrl: 'https://arbitrum.example/rpc',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      })
    ).rejects.toThrow('Acquisition private key must control the configured Filecoin wallet owner')

    expect(mockEnsureWallet).not.toHaveBeenCalled()
    expect(mockDeposit).not.toHaveBeenCalled()
  })

  it('visibly rejects parsed view-only auth before source acquisition or a Filecoin Pay deposit', async () => {
    const planned = planResult(5_000_000_000_000_000_000n)
    planned.status = { walletUsdfcBalance: 0n, filBalance: 0n }
    mockPlan.mockResolvedValueOnce(planned)
    mockParseCLIAuth.mockReturnValueOnce({ readOnly: true })

    await expect(
      runFund({
        amount: '5',
        viewAddress: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
        fromChain: 'arb',
        fromToken: 'USDC',
        maxSourceAmount: '10',
        sourceRpcUrl: 'https://arbitrum.example/rpc',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      })
    ).rejects.toThrow('Token acquisition requires signing auth; --view-address is read-only')

    expect(mockEnsureWallet).not.toHaveBeenCalled()
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(mockDeposit).not.toHaveBeenCalled()
    const message = 'Token acquisition requires signing auth; --view-address is read-only'
    expect(mockLogLine.mock.calls.flat().filter((line) => String(line).includes(message))).toHaveLength(1)
    expect(mockLogFlush).toHaveBeenCalledTimes(1)
  })

  it('keeps an acquisition-configured read-only no-op free of signing work', async () => {
    mockPlan.mockResolvedValueOnce(planResult(0n))
    mockParseCLIAuth.mockReturnValueOnce({ readOnly: true })
    const synapse = {
      chain: { id: 314 },
      payments: { accountSummary: vi.fn().mockResolvedValue({ funds: 0n }) },
    }
    mockInitialize.mockResolvedValueOnce(synapse)

    await expect(
      runFund({
        amount: '5',
        viewAddress: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
        fromChain: 'arb',
        fromToken: 'USDC',
        maxSourceAmount: '10',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      })
    ).resolves.toBeUndefined()

    expect(mockEnsureWallet).not.toHaveBeenCalled()
    expect(mockDeposit).not.toHaveBeenCalled()
  })

  it('emits a POSIX-safe acquisition resume command without including the private key', async () => {
    const planned = planResult(5_000_000_000_000_000_000n)
    planned.status = { walletUsdfcBalance: 0n, filBalance: 0n }
    const privateKey = '0x0000000000000000000000000000000000000000000000000000000000000001'
    mockPlan.mockResolvedValueOnce(planned)
    mockEnsureWallet.mockRejectedValueOnce(new Error('Squid quote failed (429)'))

    await expect(
      runFund({
        amount: '5',
        fromChain: "arb'quoted",
        fromToken: 'USDC',
        maxSourceAmount: '10',
        sourceRpcUrl: 'https://arbitrum.example/rpc?key=source-secret',
        rpcUrl: 'https://filecoin.example/rpc?key=filecoin-secret',
        privateKey,
      })
    ).rejects.toThrow('Squid quote failed')

    const line = mockLogLine.mock.calls.flat().find((value) => value.includes('After provider arrival'))
    if (line == null) throw new Error('expected acquisition recovery command')
    const command = line.slice(line.indexOf(': ') + 2)
    if (process.platform !== 'win32') {
      const argumentsList = execFileSync('/bin/sh', ['-c', `set -- ${command}; printf '%s\\n' "$@"`], {
        encoding: 'utf8',
      })
        .trimEnd()
        .split('\n')

      expect(argumentsList).toEqual([
        'filecoin-pin',
        'payments',
        'fund',
        '--amount',
        '5',
        '--from-chain',
        "arb'quoted",
        '--from-token',
        '0x1111111111111111111111111111111111111111',
        '--max-source-amount',
        '10',
      ])
    }
    expect(line).not.toContain(privateKey)
    expect(line).not.toContain('source-secret')
    expect(line).not.toContain('filecoin-secret')
  })

  it.each([
    ['Calibration', calibration.id, 'calibration'],
    ['devnet', 31_337, 'devnet'],
  ])('fails closed for %s acquisition with direct-funding recovery only', async (_networkName, destinationChainId, network) => {
    const planned = planResult(5_000_000_000_000_000_000n)
    planned.status = { walletUsdfcBalance: 0n, filBalance: 0n }
    mockInitialize.mockResolvedValueOnce({ chain: { id: destinationChainId } })
    mockPlan.mockResolvedValueOnce(planned)
    mockEnsureWallet.mockRejectedValueOnce(
      new Error('Token acquisition is available only on Filecoin mainnet; use a direct USDFC deposit on this network')
    )

    await expect(
      runFund({
        amount: '5',
        network,
        fromChain: 'arb',
        fromToken: 'USDC',
        maxSourceAmount: '10',
        sourceRpcUrl: 'https://arbitrum.example/rpc',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      })
    ).rejects.toThrow('Direct wallet funding is required on this network')

    const output = mockLogLine.mock.calls.flat().join('\n')
    expect(output).toContain('After direct wallet funding, resume with:')
    expect(output).toContain('Fund this wallet with FIL and USDFC directly')
    expect(output).toContain(`'--network' '${network}'`)
    expect(output).not.toContain('After provider arrival')
    expect(output).not.toContain('--from-chain')
    expect(output).not.toContain('--from-token')
    expect(output).not.toContain('--max-source-amount')
    expect(output).not.toContain('SOURCE_RPC_URL')
    expect(output).not.toContain('Squid fallback')
  })

  it('redacts configured and credential-bearing RPC URLs and private keys while preserving public help links', async () => {
    const sourceRpcUrl = 'https://arbitrum.example/rpc?apiKey=source-secret'
    const rpcUrl = 'https://filecoin.example/rpc?token=filecoin-secret'
    const privateKey = '0x0000000000000000000000000000000000000000000000000000000000000001'
    const publicBridgeUrl = 'https://app.usdfc.net/#/bridge'
    const publicFaucetUrl = 'https://faucet.calibnet.chainsafe-fil.io/'
    const publicSushiUrl =
      'https://www.sushi.com/filecoin/swap?token0=NATIVE&token1=0x80b98d3aa09ffff255c3ba4a241111ff1262f045'
    const unconfiguredCredentialUrl = 'https://provider.example/rpc?access_key=unconfigured-secret'
    const credentialBearingSwapUrl =
      'https://provider.example/swap?token=swap-secret&token0=NATIVE&token1=0x80b98d3aa09ffff255c3ba4a241111ff1262f045'
    const planned = planResult(5_000_000_000_000_000_000n)
    planned.status = { walletUsdfcBalance: 0n, filBalance: 0n }
    mockPlan.mockResolvedValueOnce(planned)
    mockEnsureWallet.mockRejectedValueOnce(
      new Error(
        `HTTP 429 from viem\nBridge: ${publicBridgeUrl}\nFaucet: ${publicFaucetUrl}\nSwap: ${publicSushiUrl}\nURL: ${sourceRpcUrl}\nRequest URL: ${rpcUrl}\nProvider URL: ${unconfiguredCredentialUrl}\nCredential swap: ${credentialBearingSwapUrl}\nPrivate key: ${privateKey}`
      )
    )

    const failure = await runFund({
      amount: '5',
      fromChain: 'arb',
      fromToken: 'USDC',
      maxSourceAmount: '10',
      sourceRpcUrl,
      rpcUrl,
      privateKey,
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('HTTP 429 from viem')
    expect((failure as Error).message).not.toContain(sourceRpcUrl)
    expect((failure as Error).message).not.toContain(rpcUrl)
    expect((failure as Error).message).not.toContain(unconfiguredCredentialUrl)
    expect((failure as Error).message).not.toContain(credentialBearingSwapUrl)
    expect((failure as Error).message).not.toContain(privateKey)
    expect((failure as Error).message).toContain(publicBridgeUrl)
    expect((failure as Error).message).toContain(publicFaucetUrl)
    expect((failure as Error).message).toContain(publicSushiUrl)
    expect((failure as Error).cause).toBeUndefined()

    const output = mockLogLine.mock.calls.flat().join('\n')
    expect(output).not.toContain(sourceRpcUrl)
    expect(output).not.toContain(rpcUrl)
    expect(output).not.toContain('source-secret')
    expect(output).not.toContain('filecoin-secret')
    expect(output).not.toContain('unconfigured-secret')
    expect(output).not.toContain('swap-secret')
    expect(output).not.toContain(privateKey)
  })

  it('prints sanitized confirmed acquisition evidence before the existing Filecoin Pay deposit confirmation', async () => {
    mockPlan.mockResolvedValueOnce(underfundedPlan(5_000_000_000_000_000_000n))
    mockEnsureWallet.mockResolvedValueOnce([
      {
        asset: 'usdfc',
        quoteId: 'quote-1',
        requestId: 'request-1',
        sourceTransactionHash: '0xsource',
        destinationTransactionHash: '0xdestination',
        providerExplorerUrl: 'https://axelarscan.io/gmp/source',
        status: 'confirmed',
      },
    ])
    mockConfirm.mockResolvedValueOnce(false)

    await runFund({
      amount: '5',
      fromChain: 'arb',
      fromToken: 'USDC',
      maxSourceAmount: '10',
      sourceRpcUrl: 'https://arbitrum.example/rpc',
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
    })

    expect(mockLogSection).toHaveBeenCalledWith(
      'Acquisition evidence',
      expect.arrayContaining([
        expect.stringContaining('quote quote-1'),
        expect.stringContaining('source 0xsource'),
        expect.stringContaining('destination 0xdestination'),
      ])
    )
  })

  it('reports confirmed Filecoin wallet assets and a direct deposit-only resume after deposit failure', async () => {
    mockPlan.mockResolvedValueOnce(underfundedPlan(5_000_000_000_000_000_000n))
    mockEnsureWallet.mockResolvedValueOnce([
      {
        asset: 'usdfc',
        quoteId: 'quote-1',
        sourceTransactionHash: '0xsource',
        status: 'confirmed',
      },
    ])
    mockConfirm.mockResolvedValueOnce(true)
    mockDeposit.mockRejectedValueOnce(new Error('Filecoin Pay deposit rejected'))

    await expect(
      runFund({
        amount: '5',
        fromChain: 'arb',
        fromToken: 'USDC',
        maxSourceAmount: '10',
        sourceRpcUrl: 'https://arbitrum.example/rpc',
        rpcUrl: 'https://filecoin.example/rpc',
        mode: 'minimum',
        slippage: 1,
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      })
    ).rejects.toThrow('FIL and USDFC are already in the Filecoin wallet')

    const output = mockLogLine.mock.calls.flat().join('\n')
    expect(output).toContain("'filecoin-pin' 'payments' 'fund' '--amount' '5' '--mode' 'minimum'")
    expect(output).toContain('Retry only the Filecoin Pay deposit; do not rerun source acquisition')
    expect(output).not.toContain('--from-chain')
    expect(output).not.toContain('--from-token')
    expect(output).not.toContain('--max-source-amount')
    expect(output).not.toContain('--source-rpc-url')
    expect(output).not.toContain('https://arbitrum.example/rpc')
    expect(output).not.toContain('https://filecoin.example/rpc')
  })

  it('keeps an ambient source RPC inert without a source tuple', async () => {
    const synapse = {
      chain: { id: 314 },
      payments: { accountSummary: vi.fn().mockResolvedValue({ funds: 0n }) },
    }
    mockInitialize.mockResolvedValueOnce(synapse)
    mockPlan.mockResolvedValueOnce(planResult(0n))

    await runFund({ amount: '5', sourceRpcUrl: 'https://ambient-source-rpc.example/rpc' })

    expect(mockPlan).toHaveBeenCalledWith(expect.objectContaining({ validateWalletReadiness: true }))
    expect(mockEnsureWallet).not.toHaveBeenCalled()
  })

  it.each([
    ['standalone slippage', { amount: '5', slippage: 1 }],
    [
      'partial acquisition tuple',
      { amount: '5', fromChain: 'arb', sourceRpcUrl: 'https://ambient-source-rpc.example/rpc' },
    ],
  ])('visibly rejects %s before any provider, acquisition, or deposit work', async (_description, options) => {
    const message = 'Acquisition requires --from-chain, --from-token, and --max-source-amount together'

    await expect(runFund(options)).rejects.toThrow(message)

    expect(mockLogLine.mock.calls.flat().filter((line) => String(line).includes(message))).toHaveLength(1)
    expect(mockLogFlush).toHaveBeenCalledTimes(1)
    expect(mockInitialize).not.toHaveBeenCalled()
    expect(mockEnsureWallet).not.toHaveBeenCalled()
    expect(mockDeposit).not.toHaveBeenCalled()
    expect(mockWithdraw).not.toHaveBeenCalled()
  })

  it('rejects provider-invalid slippage before initialization or acquisition work', async () => {
    const message = 'Slippage must be between 0.01 and 99.99 percent.'

    await expect(
      runFund({
        amount: '5',
        fromChain: 'arb',
        fromToken: 'USDC',
        maxSourceAmount: '10',
        slippage: 0.001,
      })
    ).rejects.toThrow(message)

    expect(mockInitialize).not.toHaveBeenCalled()
    expect(mockEnsureWallet).not.toHaveBeenCalled()
    expect(mockDeposit).not.toHaveBeenCalled()
    expect(mockWithdraw).not.toHaveBeenCalled()
  })
})
