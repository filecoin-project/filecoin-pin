import { calibration, TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as paymentsIndex from '../../core/payments/index.js'
import {
  type AccountSummary,
  calculateFilecoinPayFundingPlan,
  executeFilecoinPayFunding,
  type FilecoinPayFundingPlan,
  getFilecoinPayFundingInsights,
  getPaymentStatus,
  type PaymentStatus,
  planFilecoinPayFunding,
  type ServiceApprovalStatus,
} from '../../core/payments/index.js'
import { autoFund } from '../../payments/fund.js'

function makeStatus(params: {
  filecoinPayBalance: bigint
  lockupUsed?: bigint
  rateUsed?: bigint
  wallet?: bigint
  filBalance?: bigint
}): PaymentStatus {
  const currentAllowances: ServiceApprovalStatus = {
    rateAllowance: 0n,
    lockupAllowance: 0n,
    lockupUsed: params.lockupUsed ?? 0n,
    rateUsed: params.rateUsed ?? 0n,
    maxLockupPeriod: 30n * TIME_CONSTANTS.EPOCHS_PER_DAY,
  }

  return {
    network: 'calibration',
    chainId: 314159,
    address: '0x0000000000000000000000000000000000000000',
    filBalance: params.filBalance ?? 1_000_000_000_000_000_000n,
    walletUsdfcBalance: params.wallet ?? 0n,
    filecoinPayBalance: params.filecoinPayBalance,
    currentAllowances,
  }
}

function makeSummary(params: { filecoinPayBalance: bigint; lockupUsed?: bigint; rateUsed?: bigint }): AccountSummary {
  const totalLockup = params.lockupUsed ?? 0n
  const lockupRatePerEpoch = params.rateUsed ?? 0n
  const runwayInEpochs =
    lockupRatePerEpoch === 0n
      ? 0n
      : params.filecoinPayBalance > totalLockup
        ? (params.filecoinPayBalance - totalLockup) / lockupRatePerEpoch
        : 0n
  const grossCoverageInEpochs = lockupRatePerEpoch === 0n ? 0n : params.filecoinPayBalance / lockupRatePerEpoch
  const availableFunds = params.filecoinPayBalance > totalLockup ? params.filecoinPayBalance - totalLockup : 0n
  return {
    funds: params.filecoinPayBalance,
    availableFunds,
    debt: 0n,
    totalLockup,
    lockupRatePerEpoch,
    runwayInEpochs,
    grossCoverageInEpochs,
  }
}

function makeSynapseStub(summary?: AccountSummary) {
  const accountSummary = summary ?? {
    funds: 0n,
    availableFunds: 0n,
    debt: 0n,
    totalLockup: 0n,
    lockupRatePerEpoch: 0n,
    runwayInEpochs: 0n,
    grossCoverageInEpochs: 0n,
  }
  return {
    getClient: () => ({ getAddress: async () => '0xowner' }),
    getNetwork: () => 'calibration',
    getWarmStorageAddress: () => '0xwarm',
    getProvider: () => ({ getBalance: async () => 1_000_000_000_000_000_000n }),
    getPaymentsAddress: () => '0xpayments',
    payments: {
      serviceApproval: async () => ({
        rateAllowance: 0n,
        lockupAllowance: 0n,
        lockupUsed: 0n,
        rateUsed: 0n,
        maxLockupPeriod: 30n * TIME_CONSTANTS.EPOCHS_PER_DAY,
      }),
      allowance: async () => 0n,
      deposit: vi.fn(),
      accountSummary: async () => accountSummary,
    },
    storage: {
      createContexts: async () => [],
      getStorageInfo: async () => ({
        pricing: { noCDN: { perTiBPerEpoch: 1n } },
      }),
    },
  }
}

describe('planFilecoinPayFunding', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('plans a positive delta and detects wallet shortfall', async () => {
    const rateUsed = 1_000_000_000_000_000_000n
    const status = makeStatus({ filecoinPayBalance: 0n, lockupUsed: 0n, rateUsed, wallet: 1n })
    const summary = makeSummary({ filecoinPayBalance: 0n, rateUsed })
    vi.spyOn(paymentsIndex, 'getPaymentStatus').mockResolvedValue(status)
    vi.spyOn(paymentsIndex, 'checkAndSetAllowances').mockResolvedValue({
      updated: false,
      currentAllowances: status.currentAllowances,
    })
    vi.spyOn(paymentsIndex, 'validatePaymentRequirements').mockReturnValue({ isValid: true })

    const { plan } = await planFilecoinPayFunding({
      synapse: makeSynapseStub(summary) as any,
      targetRunwayDays: 1,
      pricePerTiBPerEpoch: 1n,
    })

    expect(plan.delta).toBeGreaterThan(0n)
    expect(plan.walletShortfall).toBe(plan.delta - status.walletUsdfcBalance)
    expect(plan.current.runway.state).toBe('active')
  })

  it('clamps withdrawals in minimum mode', async () => {
    const rateUsed = 1_000_000_000_000_000_000n
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const status = makeStatus({
      filecoinPayBalance: perDay * 10n,
      lockupUsed: 0n,
      rateUsed,
      wallet: perDay * 10n,
    })
    const summary = makeSummary({ filecoinPayBalance: perDay * 10n, rateUsed })
    vi.spyOn(paymentsIndex, 'getPaymentStatus').mockResolvedValue(status)
    vi.spyOn(paymentsIndex, 'checkAndSetAllowances').mockResolvedValue({
      updated: false,
      currentAllowances: status.currentAllowances,
    })
    vi.spyOn(paymentsIndex, 'validatePaymentRequirements').mockReturnValue({ isValid: true })

    const { plan } = await planFilecoinPayFunding({
      synapse: makeSynapseStub(summary) as any,
      targetRunwayDays: 1,
      mode: 'minimum',
      pricePerTiBPerEpoch: 1n,
      allowWithdraw: false,
    })

    expect(plan.delta).toBe(0n)
    expect(plan.action).toBe('none')
  })

  it('handles no spend (rateUsed = 0) with runway target as no-op', async () => {
    const status = makeStatus({
      filecoinPayBalance: 0n,
      lockupUsed: 0n,
      rateUsed: 0n,
      wallet: 1_000n,
    })
    const summary = makeSummary({ filecoinPayBalance: 0n, rateUsed: 0n })
    vi.spyOn(paymentsIndex, 'getPaymentStatus').mockResolvedValue(status)
    vi.spyOn(paymentsIndex, 'checkAndSetAllowances').mockResolvedValue({
      updated: false,
      currentAllowances: status.currentAllowances,
    })
    vi.spyOn(paymentsIndex, 'validatePaymentRequirements').mockReturnValue({ isValid: true })

    const { plan } = await planFilecoinPayFunding({
      synapse: makeSynapseStub(summary) as any,
      targetRunwayDays: 30,
    })

    expect(plan.delta).toBe(0n)
    expect(plan.action).toBe('none')
    expect(plan.current.runway.state).toBe('no-spend')
    expect(plan.projected.runway.state).toBe('no-spend')
  })

  it('throws when both runway and deposit targets are provided', async () => {
    const status = makeStatus({ filecoinPayBalance: 0n, wallet: 1_000n })
    vi.spyOn(paymentsIndex, 'getPaymentStatus').mockResolvedValue(status)
    vi.spyOn(paymentsIndex, 'checkAndSetAllowances').mockResolvedValue({
      updated: false,
      currentAllowances: status.currentAllowances,
    })
    vi.spyOn(paymentsIndex, 'validatePaymentRequirements').mockReturnValue({ isValid: true })

    await expect(
      planFilecoinPayFunding({
        synapse: makeSynapseStub() as any,
        targetRunwayDays: 10,
        targetDeposit: 1_000n,
      })
    ).rejects.toThrow('Specify either targetRunwayDays or targetDeposit, not both')
  })

  it('throws when no target is provided', async () => {
    const status = makeStatus({ filecoinPayBalance: 0n, wallet: 1_000n })
    vi.spyOn(paymentsIndex, 'getPaymentStatus').mockResolvedValue(status)
    vi.spyOn(paymentsIndex, 'checkAndSetAllowances').mockResolvedValue({
      updated: false,
      currentAllowances: status.currentAllowances,
    })
    vi.spyOn(paymentsIndex, 'validatePaymentRequirements').mockReturnValue({ isValid: true })

    await expect(
      planFilecoinPayFunding({
        synapse: makeSynapseStub() as any,
      })
    ).rejects.toThrow('A funding target is required')
  })

  it('fetches pricing when pieceSizeBytes is provided without pricePerTiBPerEpoch', async () => {
    const status = makeStatus({ filecoinPayBalance: 0n, wallet: 1_000n })
    vi.spyOn(paymentsIndex, 'getPaymentStatus').mockResolvedValue(status)
    vi.spyOn(paymentsIndex, 'checkAndSetAllowances').mockResolvedValue({
      updated: false,
      currentAllowances: status.currentAllowances,
    })
    vi.spyOn(paymentsIndex, 'validatePaymentRequirements').mockReturnValue({ isValid: true })

    const { plan } = await planFilecoinPayFunding({
      synapse: makeSynapseStub() as any,
      targetRunwayDays: 10,
      pieceSizeBytes: 1024,
    })

    expect(plan.pricePerTiBPerEpoch).toBe(1n)
    expect(plan.delta).toBeGreaterThan(0n)
    expect(plan.reasonCode).toBe('runway-with-piece')
  })

  it('adds sybil fees for new data sets in the shared funding plan', () => {
    const status = makeStatus({ filecoinPayBalance: 0n, wallet: 1_000_000_000_000_000_000n })
    const accountSummary = makeSummary({ filecoinPayBalance: 0n })

    const basePlan = calculateFilecoinPayFundingPlan({
      status,
      accountSummary,
      targetRunwayDays: 30,
      pieceSizeBytes: 1024,
      pricePerTiBPerEpoch: 1n,
      newDataSetCount: 0,
      mode: 'minimum',
      allowWithdraw: false,
    })

    const withFeesPlan = calculateFilecoinPayFundingPlan({
      status,
      accountSummary,
      targetRunwayDays: 30,
      pieceSizeBytes: 1024,
      pricePerTiBPerEpoch: 1n,
      newDataSetCount: 2,
      mode: 'minimum',
      allowWithdraw: false,
    })

    expect(withFeesPlan.delta - basePlan.delta).toBe(200_000_000_000_000_000n)
    expect(withFeesPlan.targetDeposit).toBe((basePlan.targetDeposit ?? 0n) + 200_000_000_000_000_000n)
  })
})

describe('executeFilecoinPayFunding', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('executes a deposit and returns updated insights', async () => {
    const initialStatus = makeStatus({ filecoinPayBalance: 0n, rateUsed: 1n, lockupUsed: 0n, wallet: 1_000n })
    const updatedStatus = makeStatus({ filecoinPayBalance: 1_000n, rateUsed: 1n, lockupUsed: 0n, wallet: 0n })
    const initialSummary = makeSummary({ filecoinPayBalance: 0n, rateUsed: 1n })
    const updatedSummary = makeSummary({ filecoinPayBalance: 1_000n, rateUsed: 1n })

    vi.spyOn(paymentsIndex, 'getPaymentStatus').mockResolvedValue(updatedStatus)
    vi.spyOn(paymentsIndex, 'depositUSDFC').mockResolvedValue({ depositTx: '0xmock-deposit' })

    const synapseStub = makeSynapseStub(updatedSummary)

    const current = getFilecoinPayFundingInsights(initialStatus, initialSummary)
    const projected = getFilecoinPayFundingInsights(updatedStatus, updatedSummary)

    const plan = {
      targetType: 'deposit' as const,
      delta: 1_000n,
      action: 'deposit' as const,
      reasonCode: 'target-deposit' as const,
      mode: 'exact' as const,
      projectedDeposit: updatedStatus.filecoinPayBalance,
      projectedRateUsed: updatedStatus.currentAllowances.rateUsed,
      projectedLockupUsed: updatedStatus.currentAllowances.lockupUsed,
      current,
      projected,
      targetDeposit: updatedStatus.filecoinPayBalance,
    }

    const result = await executeFilecoinPayFunding(synapseStub as any, plan)
    expect(paymentsIndex.depositUSDFC).toHaveBeenCalledWith(synapseStub, 1_000n)
    expect(result.adjusted).toBe(true)
    expect(result.newDepositedAmount).toBe(updatedStatus.filecoinPayBalance)
    expect(result.transactionHash).toBe('0xmock-deposit')
    expect(typeof result.newCoverageDays).toBe('number')
  })
})

describe('getFilecoinPayFundingInsights', () => {
  it('calculates per-day spend and runway from SDK summary', () => {
    const rateUsed = 2n
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const lockupUsed = 0n
    const filecoinPayBalance = perDay * 3n
    const status = makeStatus({
      filecoinPayBalance,
      rateUsed,
      lockupUsed,
      wallet: 0n,
    })
    const summary = makeSummary({ filecoinPayBalance, rateUsed, lockupUsed })

    const insights = getFilecoinPayFundingInsights(status, summary)
    expect(insights.spendRatePerDay).toBe(perDay)
    expect(insights.runway.runwayDays).toBe(3)
    expect(insights.runway.coverageDays).toBe(3)
    expect(insights.availableDeposited).toBe(filecoinPayBalance)
  })

  it('issue #385: lockup exceeds balance — coverage substantial, runway 0', () => {
    const rateUsed = 2n
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const lockupUsed = perDay * 30n
    const filecoinPayBalance = perDay * 20n
    const status = makeStatus({ filecoinPayBalance, rateUsed, lockupUsed, wallet: perDay * 2n })
    const summary = makeSummary({ filecoinPayBalance, rateUsed, lockupUsed })

    const insights = getFilecoinPayFundingInsights(status, summary)

    expect(insights.runway.runwayDays).toBe(0)
    expect(insights.runway.coverageDays).toBe(20)
    expect(insights.availableDeposited).toBe(0n)
    expect(insights.filecoinPayDepletionSeconds).toBe(20n * 86_400n)
    expect(insights.ownerDepletionSeconds).toBe(22n * 86_400n)
  })

  it('rjan90: projected ownerDepletion uses projected wallet balance after deposit', () => {
    const rateUsed = 2n
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const status = makeStatus({
      filecoinPayBalance: 0n,
      rateUsed,
      wallet: perDay * 5n,
    })
    const summary = makeSummary({ filecoinPayBalance: 0n, rateUsed })

    // Project: deposit 5 days worth — wallet should drop to 0
    const projected = getFilecoinPayFundingInsights(status, summary, {
      depositedBalance: perDay * 5n,
      rateUsed,
      lockupUsed: 0n,
      walletUsdfcBalance: 0n,
    })

    expect(projected.depositedBalance).toBe(perDay * 5n)
    expect(projected.walletUsdfcBalance).toBe(0n)
    // Owner depletion = depositedBalance + projectedWallet (0) over perDay = 5 days
    expect(projected.ownerDepletionSeconds).toBe(5n * 86_400n)
  })
})

describe('getPaymentStatus', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns gross deposited funds, not availableFunds', async () => {
    // Regression guard for issue #385: synapse.payments.balance() returns availableFunds
    // (= funds - lockup), which previously caused double-subtraction of lockup throughout
    // funding math and display. PaymentStatus.filecoinPayBalance must be gross funds.
    const grossFunds = 1_000_000_000_000_000_000n
    const lockup = 600_000_000_000_000_000n
    const availableFunds = grossFunds - lockup
    const synapseStub = {
      chain: { id: calibration.id, name: 'calibration', contracts: { fwss: { address: '0xfwss' } } },
      client: { account: '0xowner' },
      payments: {
        walletBalance: vi.fn(async ({ token }: { token: string }) => (token === 'FIL' ? 10n : 5n)),
        balance: vi.fn(async () => availableFunds),
        accountInfo: vi.fn(async () => ({
          funds: grossFunds,
          lockupCurrent: lockup,
          lockupRate: 0n,
          lockupLastSettledAt: 0n,
          availableFunds,
        })),
        serviceApproval: vi.fn(async () => ({
          rateAllowance: 0n,
          lockupAllowance: 0n,
          lockupUsage: lockup,
          rateUsage: 0n,
          maxLockupPeriod: 30n * TIME_CONSTANTS.EPOCHS_PER_DAY,
        })),
      },
    }

    const status = await getPaymentStatus(synapseStub as never)
    expect(status.filecoinPayBalance).toBe(grossFunds)
    expect(synapseStub.payments.accountInfo).toHaveBeenCalled()
  })
})

describe('autoFund (modifiers)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  function mockPlan(opts: { filecoinPayBalance: bigint; delta: bigint }): { status: PaymentStatus } {
    const status = makeStatus({
      filecoinPayBalance: opts.filecoinPayBalance,
      rateUsed: 1n,
      wallet: 1_000_000_000_000_000_000_000n,
    })
    const summary = makeSummary({ filecoinPayBalance: opts.filecoinPayBalance, rateUsed: 1n })
    const insights = getFilecoinPayFundingInsights(status, summary)
    const plan: FilecoinPayFundingPlan = {
      targetType: 'runway-days',
      delta: opts.delta,
      action: opts.delta > 0n ? 'deposit' : 'none',
      reasonCode: 'runway-insufficient',
      mode: 'minimum',
      projectedDeposit: opts.filecoinPayBalance + opts.delta,
      projectedRateUsed: 1n,
      projectedLockupUsed: 0n,
      current: insights,
      projected: insights,
    }
    vi.spyOn(paymentsIndex, 'planFilecoinPayFunding').mockResolvedValue({
      plan,
      status,
      accountSummary: summary,
      allowances: { updated: false, currentAllowances: status.currentAllowances },
    })
    return { status }
  }

  it('forwards minRunwayDays as targetRunwayDays to planFilecoinPayFunding', async () => {
    mockPlan({ filecoinPayBalance: 0n, delta: 0n })
    await autoFund({ synapse: makeSynapseStub() as any, fileSize: 0, minRunwayDays: 60 })
    expect(paymentsIndex.planFilecoinPayFunding).toHaveBeenCalledWith(expect.objectContaining({ targetRunwayDays: 60 }))
  })

  it('clamps the executed deposit to maxBalance when the plan would exceed it', async () => {
    mockPlan({ filecoinPayBalance: 80n, delta: 50n })
    vi.spyOn(paymentsIndex, 'executeFilecoinPayFunding').mockResolvedValue({
      adjusted: true,
      delta: 20n,
      newDepositedAmount: 100n,
      newRunwayDays: 30,
      newRunwayHours: 0,
      newCoverageDays: 30,
      newCoverageHours: 0,
      plan: {} as any,
      updatedInsights: {} as any,
    })

    const result = await autoFund({ synapse: makeSynapseStub() as any, fileSize: 0, maxBalance: 100n })

    const execCalls = vi.mocked(paymentsIndex.executeFilecoinPayFunding).mock.calls
    expect(execCalls).toHaveLength(1)
    const [, executedPlan] = execCalls[0] ?? []
    expect(executedPlan?.delta).toBe(20n)
    expect(result.delta).toBe(20n)
    expect(result.warnings?.[0]).toContain('Reducing')
  })

  it('returns a warning and skips the deposit when already at maxBalance', async () => {
    mockPlan({ filecoinPayBalance: 100n, delta: 50n })
    vi.spyOn(paymentsIndex, 'executeFilecoinPayFunding')

    const result = await autoFund({ synapse: makeSynapseStub() as any, fileSize: 0, maxBalance: 100n })

    expect(paymentsIndex.executeFilecoinPayFunding).not.toHaveBeenCalled()
    expect(result.adjusted).toBe(false)
    expect(result.delta).toBe(0n)
    expect(result.warnings?.[0]).toContain('already equals or exceeds')
  })
})
