import { execFileSync } from 'node:child_process'
import { calibration } from '@filoz/synapse-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  mockInitialize,
  mockGetClientAddress,
  mockEnsureWallet,
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
  mockInitialize: vi.fn(async () => ({ chain: { id: 314 } })),
  mockGetClientAddress: vi.fn(() => '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'),
  mockEnsureWallet: vi.fn(),
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

describe('runFund confirmation exit codes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsCancel.mockReturnValue(false)
    mockInitialize.mockResolvedValue({ chain: { id: 314 } })
    mockGetClientAddress.mockReturnValue('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf')
    mockEnsureWallet.mockResolvedValue(undefined)
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

  it('passes the RPC-resolved Calibration chain to acquisition even without --network', async () => {
    mockInitialize.mockResolvedValueOnce({ chain: { id: calibration.id } })
    mockPlan.mockResolvedValueOnce(planResult(5_000_000_000_000_000_000n))
    mockConfirm.mockResolvedValueOnce(false)

    await runFund({
      amount: '5',
      rpcUrl: 'https://calibration.example/rpc',
      fromChain: 'arb',
      fromToken: 'USDC',
      maxSourceAmount: '10',
      sourceRpcUrl: 'https://arbitrum.example/rpc',
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
    })

    expect(mockEnsureWallet).toHaveBeenCalledWith(expect.objectContaining({ destinationChainId: calibration.id }))
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
    expect(adjustment).toHaveBeenCalledWith(synapse, 5_000_000_000_000_000_000n)
  })

  it('uses source RPC and slippage only when the complete acquisition tuple is present', async () => {
    mockPlan.mockResolvedValueOnce(planResult(5_000_000_000_000_000_000n))
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
    mockPlan.mockResolvedValueOnce(planResult(5_000_000_000_000_000_000n))
    mockEnsureWallet.mockImplementationOnce(
      async (options: {
        confirmSourceAcquisition?: (summary: {
          sourceAmount: bigint
          maxSourceAmount: bigint
          legs: Array<{ asset: 'fil' | 'usdfc'; minimumDestinationAmount: bigint; expiresAt: number }>
        }) => Promise<void>
      }) => {
        if (options.confirmSourceAcquisition == null)
          throw new Error('expected source acquisition confirmation callback')
        await options.confirmSourceAcquisition({
          sourceAmount: 1_000_000n,
          maxSourceAmount: 10_000_000n,
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
      expect.objectContaining({ message: expect.stringContaining('1 Arbitrum USDC (cap 10)') })
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
    ).rejects.toThrow('Remaining wallet shortfalls: FIL 0.1, USDFC 5. Squid fallback: https://app.squidrouter.com/')
    expect(mockLogLine).toHaveBeenCalledWith(
      expect.stringContaining(
        "'filecoin-pin' 'payments' 'fund' '--amount' '5' '--from-chain' 'arb' '--from-token' 'USDC' '--max-source-amount' '10' '--mode' 'minimum' '--slippage' '1'"
      )
    )
    expect(mockLogLine).toHaveBeenCalledWith(expect.stringContaining('SOURCE_RPC_URL and RPC_URL'))
    expect(mockLogLine.mock.calls.flat().join('\n')).not.toContain('https://arbitrum.example/rpc')
    expect(mockLogLine.mock.calls.flat().join('\n')).not.toContain('https://filecoin.example/rpc')
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
        'USDC',
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
    mockPlan.mockResolvedValueOnce(planResult(5_000_000_000_000_000_000n))
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
    mockPlan.mockResolvedValueOnce(planResult(5_000_000_000_000_000_000n))
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
