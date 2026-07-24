import { parseUnits } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCheckAllowances,
  mockCheckAndSetAllowances,
  mockCheckFILBalance,
  mockCheckUSDFCBalance,
  mockDeposit,
  mockEnsureWallet,
  mockGetPaymentStatus,
  mockInitialize,
  mockLogLine,
  mockParseCLIAuth,
  mockValidateGasRequirement,
  mockValidatePaymentRequirements,
} = vi.hoisted(() => ({
  mockCheckAllowances: vi.fn(),
  mockCheckAndSetAllowances: vi.fn(),
  mockCheckFILBalance: vi.fn(),
  mockCheckUSDFCBalance: vi.fn(),
  mockDeposit: vi.fn(),
  mockEnsureWallet: vi.fn(),
  mockGetPaymentStatus: vi.fn(),
  mockInitialize: vi.fn(),
  mockLogLine: vi.fn(),
  mockParseCLIAuth: vi.fn(),
  mockValidateGasRequirement: vi.fn(),
  mockValidatePaymentRequirements: vi.fn(),
}))

vi.mock('../../core/payments/acquisition/orchestrate.js', () => ({
  ensureWalletReadyForFilecoinTransactions: mockEnsureWallet,
}))

vi.mock('../../core/payments/index.js', () => ({
  MIN_FIL_FOR_GAS: 100n,
  calculateDepositCapacity: vi.fn(() => ({ gibPerMonth: 0 })),
  checkAllowances: mockCheckAllowances,
  checkAndSetAllowances: mockCheckAndSetAllowances,
  checkFILBalance: mockCheckFILBalance,
  checkUSDFCBalance: mockCheckUSDFCBalance,
  computeAutoSetupTargetBalance: vi.fn(),
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
    mockCheckAllowances.mockResolvedValue({ needsUpdate: true })
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
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
      } as any)
    ).resolves.toBeUndefined()

    expect(mockEnsureWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationChainId: 314,
        requiredUsdfc: TWO_USDFC,
        walletFilBalance: 0n,
        walletUsdfcBalance: 0n,
      })
    )
    expect(mockDeposit).toHaveBeenCalledWith(expect.anything(), TWO_USDFC)
    expect(order).toEqual(['acquire', 'deposit'])
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
    [
      'an unsupported source route',
      'eth',
      'USDC',
      '1',
      'Acquisition supports only --from-chain arb and --from-token USDC',
    ],
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
    expect(output).toContain("'--from-chain' 'arb'")
    expect(output).not.toContain(sourceRpcUrl)
    expect(output).not.toContain(rpcUrl)
    expect(output).not.toContain(privateKey)
    expect(output).not.toContain('source-secret')
    expect(output).not.toContain('filecoin-secret')
    expect(output).not.toContain('unconfigured-secret')
  })
})
