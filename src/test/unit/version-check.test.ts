import { afterEach, describe, expect, it, vi } from 'vitest'

import { checkForUpdate } from '../../common/version-check.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe('version check', () => {
  it('detects when a newer version is available', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: '0.12.0' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await checkForUpdate({ currentVersion: '0.11.0' })

    expect(result).toMatchObject({
      status: 'update-available',
      currentVersion: '0.11.0',
      latestVersion: '0.12.0',
    })
    expect(fetchMock).toHaveBeenCalled()
  })

  it('returns up-to-date when versions match', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: '0.11.0' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await checkForUpdate({ currentVersion: '0.11.0' })

    expect(result).toEqual({
      status: 'up-to-date',
      currentVersion: '0.11.0',
      latestVersion: '0.11.0',
    })
  })

  it('returns error when fetch fails', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await checkForUpdate({ currentVersion: '0.11.0' })

    expect(result).toMatchObject({
      status: 'error',
      currentVersion: '0.11.0',
      message: 'network down',
    })
  })

  it('supports opting out via options', async () => {
    const result = await checkForUpdate({ currentVersion: '0.11.0', disableCheck: true })
    expect(result).toEqual({
      status: 'disabled',
      reason: 'Update check disabled by configuration',
    })
  })
})
