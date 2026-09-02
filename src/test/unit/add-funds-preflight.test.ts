import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Synapse } from '@filoz/synapse-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertUploadFunds, estimateInputBytes } from '../../add/funds-preflight.js'
import { estimateUploadCost } from '../../common/upload-flow.js'
import { checkAccountReadiness } from '../../login/readiness.js'
import { log } from '../../utils/cli-logger.js'

vi.mock('../../common/upload-flow.js', () => ({ estimateUploadCost: vi.fn() }))
vi.mock('../../login/readiness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../login/readiness.js')>()
  return { ...actual, checkAccountReadiness: vi.fn() }
})

const USDFC = 10n ** 18n

function fakeSynapse(availableFunds: bigint, chainId = 314): Synapse {
  return {
    chain: { id: chainId },
    payments: { accountSummary: vi.fn(async () => ({ availableFunds })) },
  } as unknown as Synapse
}

function costs(ready: boolean, lockups: bigint, fees: bigint, depositNeeded: bigint) {
  return {
    requestedCopies: 1,
    newDataSetCount: 0,
    costs: { ready, lockups: { total: lockups }, fees: { total: fees }, depositNeeded },
  }
}

describe('assertUploadFunds', () => {
  beforeEach(() => {
    vi.spyOn(log, 'line').mockImplementation(() => undefined)
    vi.spyOn(log, 'flush').mockImplementation(() => undefined)
    process.env.CONSOLE_URL = 'https://console.test'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.CONSOLE_URL
  })

  // ANSI codes stripped: CI forces colour on.
  const output = () =>
    vi
      .mocked(log.line)
      .mock.calls.map((c) => String(c[0]))
      .join('\n')
      .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')

  it('returns quietly when the service is approved and the estimate is covered', async () => {
    vi.mocked(checkAccountReadiness).mockResolvedValue({ serviceApproved: true, depositUsdfc: 5n * USDFC })
    vi.mocked(estimateUploadCost).mockResolvedValue(costs(true, USDFC, 0n, 0n) as never)

    await expect(
      assertUploadFunds(fakeSynapse(3n * USDFC), 1024, {}, 'filecoin-pin add ./photos')
    ).resolves.toBeUndefined()
    expect(output()).toBe('')
  })

  it('prints the readiness lines and a pre-filled link, then fails, when funds fall short', async () => {
    vi.mocked(checkAccountReadiness).mockResolvedValue({ serviceApproved: true, depositUsdfc: USDFC / 8n })
    vi.mocked(estimateUploadCost).mockResolvedValue(
      costs(false, (14n * USDFC) / 10n, 0n, (128n * USDFC) / 100n) as never
    )

    await expect(
      assertUploadFunds(fakeSynapse((12n * USDFC) / 100n), 1024, {}, 'filecoin-pin add ./photos')
    ).rejects.toThrow("Account can't pay for this upload")
    const text = output()
    expect(text).toContain('✓ session key authorized')
    expect(text).toContain('✓ storage service approved')
    expect(text).toContain('✗ available funds 0.12 USDFC — this upload needs ~1.40 USDFC (incl. 30-day reserve)')
    expect(text).toContain('https://console.test/console?deposit=2&operator=fwss')
    expect(text).toContain('Then re-run:  filecoin-pin add ./photos')
    expect(text).not.toMatch(/FWSS operator|operator approval/i)
  })

  it('names the failing step in the spinner when a read throws', async () => {
    vi.mocked(checkAccountReadiness).mockResolvedValue({ serviceApproved: true, depositUsdfc: USDFC })
    vi.mocked(estimateUploadCost).mockRejectedValue(new Error('no providers'))
    const spinner = { start: vi.fn(), stop: vi.fn(), message: vi.fn(), clear: vi.fn() }

    await expect(assertUploadFunds(fakeSynapse(USDFC), 1024, {}, 'filecoin-pin add ./photos', spinner)).rejects.toThrow(
      'no providers'
    )
    expect(spinner.stop).toHaveBeenCalledWith(expect.stringContaining('Could not read the upload cost estimate'))
  })

  it('points at the console without a link when no console is known for the chain', async () => {
    delete process.env.CONSOLE_URL
    vi.mocked(checkAccountReadiness).mockResolvedValue({ serviceApproved: false, depositUsdfc: 0n })
    vi.mocked(estimateUploadCost).mockResolvedValue(costs(false, USDFC, 0n, USDFC) as never)

    await expect(assertUploadFunds(fakeSynapse(0n, 31337), 1024, {}, 'filecoin-pin add ./photos')).rejects.toThrow()
    expect(output()).toContain('Top up and approve the storage service in the Filecoin Cloud console')
    expect(output()).not.toContain('operator=fwss')
  })

  it('fails on a missing service approval even when funds cover the estimate', async () => {
    vi.mocked(checkAccountReadiness).mockResolvedValue({ serviceApproved: false, depositUsdfc: 5n * USDFC })
    vi.mocked(estimateUploadCost).mockResolvedValue(costs(true, USDFC, 0n, 0n) as never)

    await expect(assertUploadFunds(fakeSynapse(3n * USDFC), 1024, {}, 'filecoin-pin add ./photos')).rejects.toThrow()
    const text = output()
    expect(text).toContain('✗ storage service not approved yet')
    expect(text).toContain('deposit=2&operator=fwss')
  })
})

describe('estimateInputBytes', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'add-preflight-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('sums the files under a directory, recursively', async () => {
    writeFileSync(join(dir, 'a.txt'), 'abc')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'b.txt'), 'defgh')
    writeFileSync(join(dir, '.hidden'), 'zz')
    expect(await estimateInputBytes(dir, true)).toBe(8)
    expect(await estimateInputBytes(dir, true, true)).toBe(10)
    expect(await estimateInputBytes(join(dir, 'a.txt'), false)).toBe(3)
  })
})
