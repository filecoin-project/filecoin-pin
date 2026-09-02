import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { balanceCommand, dashboardCommand } from '../../commands/account.js'
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

  it('resolves the console billing page per network, CONSOLE_URL winning', () => {
    expect(resolveDashboardUrl({})).toBe('https://pay.filecoin.cloud/console')
    expect(resolveDashboardUrl({ network: 'calibration' })).toBe('https://pay.filecoin.cloud/console')
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
  it('balance takes the same auth flags as payments status', () => {
    const longs = balanceCommand.options.map((o) => o.long)
    expect(longs).toEqual(expect.arrayContaining(['--private-key', '--session-key', '--wallet-address', '--network']))
  })

  it('dashboard takes only --network', () => {
    expect(dashboardCommand.options.map((o) => o.long)).toEqual(['--network'])
  })
})
