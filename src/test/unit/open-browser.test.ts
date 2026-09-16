import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { environmentWithoutSecrets, openBrowser } from '../../login/open-browser.js'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
// A terminal is attached, so the BROWSER check is the only thing that can decline.
vi.mock('../../utils/cli-logger.js', () => ({ isTTY: () => true }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.mocked(spawn).mockReset()
})

describe('environmentWithoutSecrets', () => {
  it('drops every credential and keeps the rest', () => {
    expect(environmentWithoutSecrets({ PRIVATE_KEY: 'x', SESSION_KEY: 'y', HOME: '/h' })).toEqual({ HOME: '/h' })
  })
})

describe('openBrowser', () => {
  it('returns false and never spawns when BROWSER=none', () => {
    vi.stubEnv('BROWSER', 'none')

    expect(openBrowser('https://console.test/console')).toBe(false)
    expect(vi.mocked(spawn)).not.toHaveBeenCalled()
  })

  it('launches the opener without credentials in its environment', () => {
    vi.stubEnv('BROWSER', undefined)
    vi.stubEnv('SESSION_KEY', '0xsecret')
    vi.mocked(spawn).mockReturnValue({ on: () => undefined, unref: () => undefined } as never)

    expect(openBrowser('https://console.test/console')).toBe(true)

    const [, args, options] = vi.mocked(spawn).mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }]
    expect(args).toContain('https://console.test/console')
    expect(options.env).not.toHaveProperty('SESSION_KEY')
  })
})
