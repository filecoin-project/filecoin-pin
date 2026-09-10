import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Synapse } from '@filoz/synapse-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertUploadFunds, estimateInputBytes, rerunHint } from '../../add/funds-preflight.js'
import { estimateUploadCost } from '../../common/upload-flow.js'
import { checkAccountReadiness } from '../../login/readiness.js'
import { log } from '../../utils/cli-logger.js'

vi.mock('node:fs/promises', () => ({ readdir: vi.fn(), stat: vi.fn() }))
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
    expect(text).toContain('0.12 USDFC')
    expect(text).toContain('~1.40 USDFC')
    expect(text).toContain('https://console.test/console?deposit=2&operator=fwss&network=mainnet')
    expect(text).toContain('filecoin-pin add ./photos')
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

  it('fails on a missing service approval even when funds cover the estimate', async () => {
    vi.mocked(checkAccountReadiness).mockResolvedValue({ serviceApproved: false, depositUsdfc: 5n * USDFC })
    vi.mocked(estimateUploadCost).mockResolvedValue(costs(true, USDFC, 0n, 0n) as never)

    await expect(assertUploadFunds(fakeSynapse(3n * USDFC), 1024, {}, 'filecoin-pin add ./photos')).rejects.toThrow()
    const text = output()
    expect(text).toContain('not approved')
    expect(text).toContain('deposit=2&operator=fwss&network=mainnet')
  })
})

describe('rerunHint', () => {
  it('rebuilds the rerun command from argv with secret flag values redacted', () => {
    expect(rerunHint(['node', 'cli', 'add', './photos', '--copies', '1'])).toBe('filecoin-pin add ./photos --copies 1')
    expect(rerunHint(['node', 'cli', 'add', '--session-key', '0xsecret', './photos'])).toBe(
      'filecoin-pin add --session-key <redacted> ./photos'
    )
    expect(rerunHint(['node', 'cli', 'add', '--private-key=0xsecret', './photos'])).toBe(
      'filecoin-pin add --private-key <redacted> ./photos'
    )
  })
})

describe('estimateInputBytes', () => {
  // A directory holding a.txt (3 bytes), sub/b.txt (5 bytes) and a 2-byte dotfile.
  const dir = '/photos'
  const entry = (parentPath: string, name: string, isFile = true) => ({ name, parentPath, isFile: () => isFile })
  // Keyed with join() so the lookup matches the separator the code builds paths with on every OS.
  const sizes: Record<string, number> = {
    [join(dir, 'a.txt')]: 3,
    [join(dir, 'sub', 'b.txt')]: 5,
    [join(dir, '.hidden')]: 2,
  }

  beforeEach(() => {
    vi.mocked(readdir).mockResolvedValue([
      entry(dir, 'a.txt'),
      entry(dir, 'sub', false),
      entry(`${dir}/sub`, 'b.txt'),
      entry(dir, '.hidden'),
    ] as never)
    vi.mocked(stat).mockImplementation(async (path) => ({ size: sizes[String(path)] ?? 0 }) as never)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('sums the files under a directory, skipping dotfiles unless asked to include them', async () => {
    expect(await estimateInputBytes(dir, true)).toBe(8)
    expect(await estimateInputBytes(dir, true, true)).toBe(10)
    expect(vi.mocked(readdir)).toHaveBeenCalledWith(dir, { recursive: true, withFileTypes: true })
  })

  it('is the file size for a single file', async () => {
    expect(await estimateInputBytes(join(dir, 'a.txt'), false)).toBe(3)
    expect(vi.mocked(readdir)).not.toHaveBeenCalled()
  })
})
