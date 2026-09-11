import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Synapse } from '@filoz/synapse-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertUploadFunds, estimateInputBytes, rerunHint } from '../../common/funds-preflight.js'
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
    vi.stubEnv('CONSOLE_URL', 'https://console.test')
  })

  afterEach(() => {
    // restoreAllMocks leaves mockResolvedValue on module mocks in place; reset clears them too.
    vi.resetAllMocks()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
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
    // Lockups 1.40 + fees 0.05 differ from available 0.12 + shortfall 3.28, and 3.28 rounds
    // up to 4, not the default 2: each branch of the funds line and the deposit is pinned.
    vi.mocked(estimateUploadCost).mockResolvedValue(
      costs(false, (14n * USDFC) / 10n, (5n * USDFC) / 100n, (328n * USDFC) / 100n) as never
    )

    await expect(
      assertUploadFunds(fakeSynapse((12n * USDFC) / 100n), 1024, {}, 'filecoin-pin add ./photos')
    ).rejects.toThrow("Account can't pay for this upload")
    const text = output()
    expect(text).toContain('✗ available funds 0.12 USDFC')
    expect(text).toContain('~3.40 USDFC')
    expect(text).toContain('https://console.test/console?deposit=4&operator=fwss&network=mainnet')
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

    await expect(assertUploadFunds(fakeSynapse(3n * USDFC), 1024, {}, 'filecoin-pin add ./photos')).rejects.toThrow(
      "Account can't pay for this upload"
    )
    const text = output()
    expect(text).toContain('not approved')
    expect(text).toContain('✓ available funds')
    expect(text).toContain('deposit=2&operator=fwss&network=mainnet')
  })
})

describe('rerunHint', () => {
  it.each([
    ['no secret flag', ['add', './photos', '--copies', '1'], 'filecoin-pin add ./photos --copies 1'],
    [
      'a separate secret value',
      ['add', '--session-key', '0xsecret', './photos'],
      'filecoin-pin add --session-key <redacted> ./photos',
    ],
    [
      'an inline secret value',
      ['add', '--private-key=0xsecret', './photos'],
      'filecoin-pin add --private-key <redacted> ./photos',
    ],
    ['a secret flag as the last word', ['add', '--session-key'], 'filecoin-pin add --session-key <redacted>'],
    [
      'an RPC URL, which can carry an API key',
      ['add', '--rpc-url', 'https://rpc.example/v1/apikey', './photos'],
      'filecoin-pin add --rpc-url <redacted> ./photos',
    ],
    [
      'an empty inline secret value',
      ['add', '--session-key=', './photos'],
      'filecoin-pin add --session-key <redacted> ./photos',
    ],
  ])('rebuilds the command from argv with %s', (_case, args, expected) => {
    expect(rerunHint(['node', 'cli', ...args])).toBe(expected)
  })
})

describe('estimateInputBytes', () => {
  // a.txt (3 bytes), sub/b.txt (5 bytes), a 2-byte dotfile, and 7 bytes under a dot-directory.
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'funds-preflight-'))
    mkdirSync(join(dir, 'sub'))
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, 'a.txt'), 'abc')
    writeFileSync(join(dir, 'sub', 'b.txt'), 'bcdef')
    writeFileSync(join(dir, '.hidden'), 'hi')
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: x/')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('sums the files under a directory recursively, skipping dot-named files and directories', async () => {
    expect(await estimateInputBytes(dir, true)).toBe(8)
  })

  it('counts hidden entries when asked to include hidden files', async () => {
    expect(await estimateInputBytes(dir, true, true)).toBe(17)
  })

  it('counts the contents of a hidden root the user named explicitly', async () => {
    expect(await estimateInputBytes(join(dir, '.git'), true)).toBe(7)
  })

  it('is the file size for a single file', async () => {
    expect(await estimateInputBytes(join(dir, 'a.txt'), false)).toBe(3)
  })
})
