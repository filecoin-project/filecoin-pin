import { TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as paymentsIndex from '../../core/payments/index.js'
import {
  executeFilecoinPayFunding,
  getFilecoinPayFundingInsights,
  type PaymentStatus,
  planFilecoinPayFunding,
  type ServiceApprovalStatus,
} from '../../core/payments/index.js'

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
