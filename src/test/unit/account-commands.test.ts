import type { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { balanceCommand, dashboardCommand } from '../../commands/account.js'
import { paymentsCommand } from '../../commands/payments.js'
import { openBrowser } from '../../login/open-browser.js'
import { resolveDashboardUrl, runDashboard } from '../../login/run-dashboard.js'
import { showPaymentStatus } from '../../payments/status.js'
import { log } from '../../utils/cli-logger.js'

vi.mock('../../login/open-browser.js', () => ({ openBrowser: vi.fn(() => false) }))
vi.mock('../../payments/status.js', () => ({ showPaymentStatus: vi.fn() }))

describe('dashboard', () => {
  beforeEach(() => {
    vi.spyOn(log, 'line').mockImplementation(() => undefined)
    vi.spyOn(log, 'flush').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.CONSOLE_URL
  })

  it('resolves the shared console billing page for mainnet and calibration, CONSOLE_URL winning', () => {
    expect(resolveDashboardUrl({})).toBe('https://pay.filecoin.cloud/console')
    expect(resolveDashboardUrl({ network: 'calibration' })).toBe('https://pay.filecoin.cloud/console')
    expect(resolveDashboardUrl({ network: 'calibnet' })).toBe('https://pay.filecoin.cloud/console')
    process.env.CONSOLE_URL = 'https://console.test/'
    expect(resolveDashboardUrl({ network: 'devnet' })).toBe('https://console.test/console')
  })

  it('fails for a network without a console', () => {
    expect(() => resolveDashboardUrl({ network: 'devnet' })).toThrow(/No Filecoin Cloud console/)
  })

  it('prints the URL, and says it opened the browser only when it did', () => {
    const text = () =>
      vi
        .mocked(log.line)
        .mock.calls.map((c) => String(c[0]))
        .join('\n')
    runDashboard({})
    expect(text()).toContain('https://pay.filecoin.cloud/console')
    expect(text()).toContain('Open the Filecoin Cloud console at the URL above.')
    expect(vi.mocked(openBrowser)).toHaveBeenCalledWith('https://pay.filecoin.cloud/console')

    vi.mocked(log.line).mockClear()
    vi.mocked(openBrowser).mockReturnValueOnce(true)
    runDashboard({})
    expect(text()).toContain('Opening the Filecoin Cloud console in your browser')
  })
})

describe('balance', () => {
  beforeEach(() => {
    vi.spyOn(log, 'line').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = 0
  })

  it('delegates to payments status with the dashboard pointer as the footer', async () => {
    vi.mocked(showPaymentStatus).mockResolvedValueOnce(undefined)
    await balanceCommand.parseAsync(['--private-key', '0xabc'], { from: 'user' })
    expect(vi.mocked(showPaymentStatus)).toHaveBeenCalledWith(
      expect.objectContaining({ privateKey: '0xabc', footer: expect.stringContaining('filecoin-pin dashboard') })
    )
    expect(process.exitCode ?? 0).toBe(0)
  })

  it('sets exit code 1 when status fails', async () => {
    vi.mocked(showPaymentStatus).mockRejectedValueOnce(new Error('rpc down'))
    await balanceCommand.parseAsync(['--private-key', '0xabc'], { from: 'user' })
    expect(process.exitCode).toBe(1)
  })
})

describe('account command wiring', () => {
  it('balance takes exactly the auth and network flags of payments status', () => {
    const statusCommand = paymentsCommand.commands.find((c) => c.name() === 'status')
    const flagsOf = (c: Command | undefined) =>
      (c?.options ?? []).map((o) => o.long).filter((l) => l !== '--include-rails')
    expect(flagsOf(balanceCommand)).toEqual(flagsOf(statusCommand))
  })

  it('dashboard is wired', () => {
    expect(dashboardCommand.name()).toBe('dashboard')
  })
})
