import { describe, expect, it, vi } from 'vitest'

const init = vi.fn()
vi.mock('@sentry/node', () => ({ init, setTags: vi.fn() }))

describe('instrument', () => {
  it('turns off Sentry PII collection', async () => {
    await import('../../instrument.js')
    expect(init.mock.calls[0]?.[0].dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
    })
  })
})
