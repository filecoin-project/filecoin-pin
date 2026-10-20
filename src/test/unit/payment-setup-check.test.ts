import type { getPriceList } from '@filoz/synapse-core/warm-storage'
import type { Synapse } from '@filoz/synapse-sdk'
import { TIME_CONSTANTS, TOKENS } from '@filoz/synapse-sdk'
import { describe, expect, it, vi } from 'vitest'
import { validatePaymentSetup } from '../../common/upload-flow.js'
import { checkUploadReadiness } from '../../core/upload/index.js'

// `add` runs the minimum setup check as `validatePaymentSetup(synapse, 0)`.
// Issue #719: that 0 reached synapse-core's lockup math as a piece size and
// threw. Only the two chain reads are faked here; the readiness check, the
// capacity check, and synapse-core's own calculation all run for real.

vi.mock('@filoz/synapse-core/pay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@filoz/synapse-core/pay')>()),
  isFwssMaxApproved: vi.fn().mockResolvedValue(true),
}))

vi.mock('@filoz/synapse-core/warm-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@filoz/synapse-core/warm-storage')>()),
  getPriceList: vi.fn().mockResolvedValue({
    token: '0x0000000000000000000000000000000000000000',
    rates: {
      storagePerTibPerMonth: 1_000_000_000_000_000n * TIME_CONSTANTS.EPOCHS_PER_MONTH,
      datasetFeePerMonth: 0n,
      cdnEgressPerTib: 0n,
      cacheMissEgressPerTib: 0n,
    },
    fees: {
      createDataSetFee: 0n,
      addPiecesBaseFee: 0n,
      addPiecesPerPieceFee: 0n,
      schedulePieceRemovalsFee: 0n,
      terminateFee: 0n,
    },
    lockups: {
      lifecycleReserveTarget: 0n,
      replenishThreshold: 0n,
      defaultLockupPeriod: 30n * TIME_CONSTANTS.EPOCHS_PER_DAY,
      cdnLockupAmount: 0n,
      cacheMissLockupAmount: 0n,
      cdnLockupPeriod: 0n,
    },
  } satisfies getPriceList.OutputType),
}))

/** A funded private-key account with max allowances already set. */
function fundedSynapse(): Synapse {
  return {
    chain: { id: 314159, name: 'calibration', contracts: { fwss: { address: '0xfwss' } } },
    client: { account: '0xabc' },
    payments: {
      walletBalance: async ({ token }: { token: string }) => (token === TOKENS.FIL ? 10n ** 18n : 10n ** 19n),
      accountInfo: async () => ({ availableFunds: 10n ** 19n, funds: 10n ** 19n, lockupCurrent: 0n }),
      serviceApproval: async () => ({
        isApproved: true,
        rateAllowance: 2n ** 255n,
        lockupAllowance: 2n ** 255n,
        rateUsage: 0n,
        lockupUsage: 0n,
        maxLockupPeriod: 2n ** 255n,
      }),
    },
  } as unknown as Synapse
}

describe('minimum payment setup check (issue #719)', () => {
  it('validatePaymentSetup(synapse, 0), the call add makes, resolves', async () => {
    await expect(validatePaymentSetup(fundedSynapse(), 0)).resolves.toBeUndefined()
  })

  it('checkUploadReadiness with fileSize 0 reports capacity with nothing locked up', async () => {
    const result = await checkUploadReadiness({ synapse: fundedSynapse(), fileSize: 0 })

    expect(result.validation.isValid).toBe(true)
    expect(result.capacity?.canUpload).toBe(true)
    expect(result.capacity?.required.lockupAllowance).toBe(0n)
  })
})
