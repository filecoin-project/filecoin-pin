import { afterEach, describe, expect, it } from 'vitest'
import { buildAuthorizeUrl, resolveConsoleUrl } from '../../core/session/console-url.js'

const previousConsoleUrl = process.env.CONSOLE_URL

afterEach(() => {
  if (previousConsoleUrl == null) {
    delete process.env.CONSOLE_URL
  } else {
    process.env.CONSOLE_URL = previousConsoleUrl
  }
})

describe('resolveConsoleUrl', () => {
  it('defaults to the production console on both networks', () => {
    delete process.env.CONSOLE_URL
    expect(resolveConsoleUrl(314)).toBe('https://pay.filecoin.cloud')
    expect(resolveConsoleUrl(314159)).toBe('https://pay.filecoin.cloud')
  })

  it('returns undefined for unknown chains', () => {
    delete process.env.CONSOLE_URL
    expect(resolveConsoleUrl(1)).toBeUndefined()
  })

  it('prefers CONSOLE_URL over the default', () => {
    process.env.CONSOLE_URL = 'http://localhost:3005'
    expect(resolveConsoleUrl(314)).toBe('http://localhost:3005')
  })
})

describe('buildAuthorizeUrl', () => {
  it('builds the session-keys deep link with pairing params', () => {
    expect(
      buildAuthorizeUrl('https://pay.filecoin.cloud', '0xAbC0000000000000000000000000000000000001', [
        'createDataSet',
        'addPieces',
      ])
    ).toBe(
      'https://pay.filecoin.cloud/console/session-keys?authorize=0xAbC0000000000000000000000000000000000001&scopes=createDataSet,addPieces'
    )
  })

  it('tolerates a trailing slash on the base URL', () => {
    expect(buildAuthorizeUrl('http://localhost:3005/', '0xA', ['addPieces'])).toBe(
      'http://localhost:3005/console/session-keys?authorize=0xA&scopes=addPieces'
    )
  })
})

describe('buildAuthorizeUrl network param', () => {
  it('carries the network slug for known chain ids', () => {
    expect(buildAuthorizeUrl('https://pay.filecoin.cloud', '0xA', ['addPieces'], 314159)).toBe(
      'https://pay.filecoin.cloud/console/session-keys?authorize=0xA&scopes=addPieces&network=calibration'
    )
    expect(buildAuthorizeUrl('https://pay.filecoin.cloud', '0xA', ['addPieces'], 314)).toMatch(/&network=mainnet$/)
  })

  it('omits the param for unknown or missing chain ids', () => {
    expect(buildAuthorizeUrl('https://pay.filecoin.cloud', '0xA', ['addPieces'], 1)).not.toMatch(/network=/)
    expect(buildAuthorizeUrl('https://pay.filecoin.cloud', '0xA', ['addPieces'])).not.toMatch(/network=/)
  })
})
