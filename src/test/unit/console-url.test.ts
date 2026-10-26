import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildAuthorizeUrl,
  buildConsoleUrl,
  buildFundingUrl,
  buildRevokeUrl,
  DEFAULT_CONSOLE_URL,
  resolveConsoleUrl,
} from '../../core/session/console-url.js'
import { configureTelemetry } from '../../core/telemetry/index.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveConsoleUrl', () => {
  it('defaults to the production console', () => {
    vi.stubEnv('CONSOLE_URL', undefined)
    expect(resolveConsoleUrl()).toBe(DEFAULT_CONSOLE_URL)
  })

  it('prefers CONSOLE_URL over the default', () => {
    vi.stubEnv('CONSOLE_URL', 'http://localhost:3005')
    expect(resolveConsoleUrl()).toBe('http://localhost:3005')
  })
})

describe('buildAuthorizeUrl', () => {
  it('builds the setup link with pairing params, lowercasing the address', () => {
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
      'https://pay.filecoin.cloud/console/setup?network=mainnet&authorize=0xabc0000000000000000000000000000000000001&scopes=createDataSet,addPieces'
    )
  })

  it('tolerates a trailing slash on the base URL', () => {
    expect(buildAuthorizeUrl('http://localhost:3005/', '0xA', ['addPieces'], 314)).toBe(
      'http://localhost:3005/console/setup?network=mainnet&authorize=0xa&scopes=addPieces'
    )
  })
})

describe('buildAuthorizeUrl network param', () => {
  it('carries the network slug for known chain ids', () => {
    expect(buildAuthorizeUrl('https://pay.filecoin.cloud', '0xA', ['addPieces'], 314159)).toBe(
      'https://pay.filecoin.cloud/console/setup?network=calibration&authorize=0xa&scopes=addPieces'
    )
    expect(buildAuthorizeUrl('https://pay.filecoin.cloud', '0xA', ['addPieces'], 314)).toMatch(/\?network=mainnet&/)
  })

  it('omits the param for an unknown chain id', () => {
    expect(buildAuthorizeUrl('https://pay.filecoin.cloud', '0xA', ['addPieces'], 1)).toBe(
      'https://pay.filecoin.cloud/console/setup?authorize=0xa&scopes=addPieces'
    )
  })
})

describe('buildAuthorizeUrl key agreement', () => {
  it('appends pubkey and pubkeysig after the scopes when given', () => {
    expect(
      buildAuthorizeUrl('https://pay.filecoin.cloud', '0xA', ['addPieces'], 314159, {
        pubkey: '0x04ab',
        pubkeysig: '0xcd',
      })
    ).toBe(
      'https://pay.filecoin.cloud/console/setup?network=calibration&authorize=0xa&scopes=addPieces&pubkey=0x04ab&pubkeysig=0xcd'
    )
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

describe('buildRevokeUrl', () => {
  it('names the key and its network, lowercasing the address', () => {
    expect(
      buildRevokeUrl('https://pay.filecoin.cloud', '0xAbC0000000000000000000000000000000000001', 'calibration')
    ).toBe(
      'https://pay.filecoin.cloud/console/session-keys?revoke=0xabc0000000000000000000000000000000000001&network=calibration'
    )
  })

  it('tolerates a trailing slash on the base URL', () => {
    expect(buildRevokeUrl('http://localhost:3005/', '0xA', 'mainnet')).toBe(
      'http://localhost:3005/console/session-keys?revoke=0xa&network=mainnet'
    )
  })

  it.each([
    ['devnet'],
    ['nonsense'],
    [undefined],
  ])('falls back to the plain page for a link the console cannot place: %s', (network) => {
    expect(buildRevokeUrl('https://pay.filecoin.cloud', '0xA', network)).toBe(
      'https://pay.filecoin.cloud/console/session-keys'
    )
  })
})

describe('console attribution', () => {
  beforeEach(() => {
    configureTelemetry({ disabled: false })
  })

  it('tags links by default with the source, the affordance, and the flow', () => {
    expect(buildConsoleUrl('https://pay.filecoin.cloud')).toBe(
      'https://pay.filecoin.cloud/console?utm_source=filecoin-pin&utm_medium=library&utm_term=dashboard'
    )
    expect(buildFundingUrl('https://pay.filecoin.cloud', 2, 314)).toBe(
      'https://pay.filecoin.cloud/console?deposit=2&operator=fwss&network=mainnet&utm_source=filecoin-pin&utm_medium=library&utm_term=fund'
    )
  })

  it('adds who is driving when the host set it, on every flow', () => {
    configureTelemetry({ affordance: 'CLI', driver: 'claude' })
    const utm = 'utm_source=filecoin-pin&utm_medium=cli'
    expect(buildAuthorizeUrl('https://pay.filecoin.cloud', '0xA', ['upload'], 314)).toMatch(
      new RegExp(`&scopes=upload&${utm}&utm_term=login&utm_content=claude$`)
    )
    expect(buildRevokeUrl('https://pay.filecoin.cloud', '0xA', 'mainnet')).toMatch(
      new RegExp(`&network=mainnet&${utm}&utm_term=revoke&utm_content=claude$`)
    )
    expect(buildRevokeUrl('https://pay.filecoin.cloud', '0xA', 'devnet')).toBe(
      `https://pay.filecoin.cloud/console/session-keys?${utm}&utm_term=revoke&utm_content=claude`
    )
    expect(buildConsoleUrl('https://pay.filecoin.cloud')).toBe(
      `https://pay.filecoin.cloud/console?${utm}&utm_term=dashboard&utm_content=claude`
    )
  })

  it('slugs a multi-word affordance and url-encodes the driver', () => {
    configureTelemetry({ affordance: 'GitHub Action', driver: 'my agent&x' })
    expect(buildConsoleUrl('https://pay.filecoin.cloud')).toMatch(
      /\?utm_source=filecoin-pin&utm_medium=github-action&utm_term=dashboard&utm_content=my%20agent%26x$/
    )
  })

  it('drops every utm param when telemetry is disabled', () => {
    configureTelemetry({ disabled: true, driver: 'claude' })
    expect(buildConsoleUrl('https://pay.filecoin.cloud')).toBe('https://pay.filecoin.cloud/console')
    expect(buildFundingUrl('https://pay.filecoin.cloud', 2, 314)).not.toContain('utm_')
  })
})
