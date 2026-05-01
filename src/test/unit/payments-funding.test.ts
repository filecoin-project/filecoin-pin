import { TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as paymentsIndex from '../../core/payments/index.js'
import {
  executeFilecoinPayFunding,
  type FilecoinPayFundingPlan,
  getFilecoinPayFundingInsights,
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

function makeSynapseStub() {
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
    },
    storage: {
      getStorageInfo: async () => ({
        pricing: { noCDN: { perTiBPerEpoch: 1n } },
      }),
    },
  }
}

describe('planFilecoinPayFunding', () => {
  const synapseStub = makeSynapseStub()

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('plans a positive delta and detects wallet shortfall', async () => {
    const rateUsed = 1_000_000_000_000_000_000n // 1 USDFC/epoch
    const status = makeStatus({ filecoinPayBalance: 0n, lockupUsed: 0n, rateUsed, wallet: 1n })
    vi.spyOn(paymentsIndex, 'getPaymentStatus').mockResolvedValue(status)
    vi.spyOn(paymentsIndex, 'checkAndSetAllowances').mockResolvedValue({
      updated: false,
      currentAllowances: status.currentAllowances,
    })
    vi.spyOn(paymentsIndex, 'validatePaymentRequirements').mockReturnValue({ isValid: true })

    const { plan } = await planFilecoinPayFunding({
      synapse: synapseStub as any,
      targetRunwayDays: 1,
      pricePerTiBPerEpoch: 1n, // avoid storage fetch
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
    vi.spyOn(paymentsIndex, 'getPaymentStatus').mockResolvedValue(status)
    vi.spyOn(paymentsIndex, 'checkAndSetAllowances').mockResolvedValue({
      updated: false,
      currentAllowances: status.currentAllowances,
    })
    vi.spyOn(paymentsIndex, 'validatePaymentRequirements').mockReturnValue({ isValid: true })

    const { plan } = await planFilecoinPayFunding({
      synapse: synapseStub as any,
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
    vi.spyOn(paymentsIndex, 'getPaymentStatus').mockResolvedValue(status)
    vi.spyOn(paymentsIndex, 'checkAndSetAllowances').mockResolvedValue({
      updated: false,
      currentAllowances: status.currentAllowances,
    })
    vi.spyOn(paymentsIndex, 'validatePaymentRequirements').mockReturnValue({ isValid: true })

    const { plan } = await planFilecoinPayFunding({
      synapse: synapseStub as any,
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
        synapse: synapseStub as any,
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
        synapse: synapseStub as any,
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
      synapse: synapseStub as any,
      targetRunwayDays: 10,
      pieceSizeBytes: 1024,
    })

    expect(plan.pricePerTiBPerEpoch).toBe(1n)
    expect(plan.delta).toBeGreaterThan(0n)
    expect(plan.reasonCode).toBe('runway-with-piece')
  })
})

describe('executeFilecoinPayFunding', () => {
  const synapseStub = makeSynapseStub()

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('executes a deposit and returns updated insights', async () => {
    const initialStatus = makeStatus({ filecoinPayBalance: 0n, rateUsed: 1n, lockupUsed: 0n, wallet: 1_000n })
    const updatedStatus = makeStatus({ filecoinPayBalance: 1_000n, rateUsed: 1n, lockupUsed: 0n, wallet: 0n })

    vi.spyOn(paymentsIndex, 'getPaymentStatus').mockResolvedValue(updatedStatus)
    vi.spyOn(paymentsIndex, 'depositUSDFC').mockResolvedValue({ depositTx: '0xmock-deposit' })

    const current = getFilecoinPayFundingInsights(initialStatus)
    const projected = getFilecoinPayFundingInsights(updatedStatus)

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
  })
})

describe('getFilecoinPayFundingInsights', () => {
  it('calculates per-day spend and runway', () => {
    const rateUsed = 2n
    const perDay = rateUsed * TIME_CONSTANTS.EPOCHS_PER_DAY
    const lockupUsed = 0n
    const available = perDay * 3n
    const status = makeStatus({
      filecoinPayBalance: available + lockupUsed,
      rateUsed,
      lockupUsed,
      wallet: 0n,
    })

    const insights = getFilecoinPayFundingInsights(status)
    expect(insights.spendRatePerDay).toBe(perDay)
    expect(insights.runway.days).toBe(3)
    expect(insights.availableDeposited).toBe(available)
  })
})

describe('autoFund (modifiers)', () => {
  const synapseStub = makeSynapseStub()

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  function mockPlan(opts: { filecoinPayBalance: bigint; delta: bigint }): { status: PaymentStatus } {
    const status = makeStatus({
      filecoinPayBalance: opts.filecoinPayBalance,
      rateUsed: 1n,
      wallet: 1_000_000_000_000_000_000_000n,
    })
    const insights = getFilecoinPayFundingInsights(status)
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
      allowances: { updated: false, currentAllowances: status.currentAllowances },
    })
    return { status }
  }

  it('forwards minRunwayDays as targetRunwayDays to planFilecoinPayFunding', async () => {
    mockPlan({ filecoinPayBalance: 0n, delta: 0n }) // delta 0n -> no-op return
    await autoFund({ synapse: synapseStub as any, fileSize: 0, minRunwayDays: 60 })
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
      plan: {} as any,
      updatedInsights: {} as any,
    })

    const result = await autoFund({ synapse: synapseStub as any, fileSize: 0, maxBalance: 100n })

    const execCalls = vi.mocked(paymentsIndex.executeFilecoinPayFunding).mock.calls
    expect(execCalls).toHaveLength(1)
    const [, executedPlan] = execCalls[0] ?? []
    expect(executedPlan?.delta).toBe(20n) // 100 (limit) - 80 (current) = 20
    expect(result.delta).toBe(20n)
    expect(result.warnings?.[0]).toContain('Reducing')
  })

  it('returns a warning and skips the deposit when already at maxBalance', async () => {
    mockPlan({ filecoinPayBalance: 100n, delta: 50n })
    vi.spyOn(paymentsIndex, 'executeFilecoinPayFunding')

    const result = await autoFund({ synapse: synapseStub as any, fileSize: 0, maxBalance: 100n })

    expect(paymentsIndex.executeFilecoinPayFunding).not.toHaveBeenCalled()
    expect(result.adjusted).toBe(false)
    expect(result.delta).toBe(0n)
    expect(result.warnings?.[0]).toContain('already equals or exceeds')
  })
})
