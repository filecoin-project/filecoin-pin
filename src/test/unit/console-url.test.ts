import { afterEach, describe, expect, it } from 'vitest'
import { buildAuthorizeUrl, buildFundingUrl, resolveConsoleUrl } from '../../core/session/console-url.js'

const previousConsoleUrl = process.env.CONSOLE_URL

afterEach(() => {
  if (previousConsoleUrl == null) {
    delete process.env.CONSOLE_URL
  } else {
    process.env.CONSOLE_URL = previousConsoleUrl
  }
})

describe('resolveConsoleUrl', () => {
  it('defaults to the production console', () => {
    delete process.env.CONSOLE_URL
    expect(resolveConsoleUrl()).toBe('https://pay.filecoin.cloud')
  })

  it('prefers CONSOLE_URL over the default', () => {
    process.env.CONSOLE_URL = 'http://localhost:3005'
    expect(resolveConsoleUrl()).toBe('http://localhost:3005')
  })
})

describe('buildAuthorizeUrl', () => {
  it('builds the session-keys deep link with pairing params, lowercasing the address', () => {
    // Lowercase is the contract: the console's strict isAddress silently
    // rejects mixed-case with a wrong EIP-55 checksum; lowercase always passes.
    expect(
      buildAuthorizeUrl(
        'https://pay.filecoin.cloud',
        '0xAbC0000000000000000000000000000000000001',
        ['createDataSet', 'addPieces'],
        314
      )
    ).toBe(
      'https://pay.filecoin.cloud/console/session-keys?authorize=0xabc0000000000000000000000000000000000001&scopes=createDataSet,addPieces&network=mainnet'
    )
  })

  it('tolerates a trailing slash on the base URL', () => {
    expect(buildAuthorizeUrl('http://localhost:3005/', '0xA', ['addPieces'], 314)).toBe(
      'http://localhost:3005/console/session-keys?authorize=0xa&scopes=addPieces&network=mainnet'
    )
  })
})

describe('buildAuthorizeUrl network param', () => {
  it('carries the network slug for known chain ids', () => {
    expect(buildAuthorizeUrl('https://pay.filecoin.cloud', '0xA', ['addPieces'], 314159)).toBe(
      'https://pay.filecoin.cloud/console/session-keys?authorize=0xa&scopes=addPieces&network=calibration'
    )
    expect(buildAuthorizeUrl('https://pay.filecoin.cloud', '0xA', ['addPieces'], 314)).toMatch(/&network=mainnet$/)
  })

  it('omits the param for an unknown chain id', () => {
    expect(buildAuthorizeUrl('https://pay.filecoin.cloud', '0xA', ['addPieces'], 1)).not.toMatch(/network=/)
  })
})

describe('buildFundingUrl', () => {
  it('names the deposit, the storage service, and the network', () => {
    expect(buildFundingUrl('https://pay.filecoin.cloud/', 2, 314159)).toBe(
      'https://pay.filecoin.cloud/console?deposit=2&operator=fwss&network=calibration'
    )
    expect(buildFundingUrl('https://pay.filecoin.cloud', 5, 314)).toMatch(/&network=mainnet$/)
  })
})
