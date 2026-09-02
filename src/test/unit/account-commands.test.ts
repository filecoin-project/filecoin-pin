import type { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { balanceCommand, dashboardCommand } from '../../commands/account.js'
import { paymentsCommand } from '../../commands/payments.js'
import { openBrowser } from '../../login/open-browser.js'
import { resolveDashboardUrl, runDashboard } from '../../login/run-dashboard.js'
import { log } from '../../utils/cli-logger.js'

vi.mock('../../login/open-browser.js', () => ({ openBrowser: vi.fn(() => false) }))

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

  it('prints the URL and opens the browser', () => {
    runDashboard({})
    const text = vi
      .mocked(log.line)
      .mock.calls.map((c) => String(c[0]))
      .join('\n')
    expect(text).toContain('Opening the Filecoin Cloud console in your browser')
    expect(text).toContain('https://pay.filecoin.cloud/console')
    expect(vi.mocked(openBrowser)).toHaveBeenCalledWith('https://pay.filecoin.cloud/console')
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
