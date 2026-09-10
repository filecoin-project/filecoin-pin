import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertOwnerAuth, parseCLIAuth, parseContextSelectionOptions } from '../../utils/cli-auth.js'
import { log } from '../../utils/cli-logger.js'
import {
  getSessionCredentialNetwork,
  getSessionCredentialSource,
  wasSessionSkippedForViewAddress,
} from '../../utils/credential-source.js'

vi.mock('../../utils/credential-source.js', () => ({
  getSessionCredentialSource: vi.fn(() => undefined),
  getSessionCredentialNetwork: vi.fn(() => undefined),
  wasSessionSkippedForViewAddress: vi.fn(() => false),
}))

describe('parseContextSelectionOptions empty-list regression', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.PROVIDER_IDS
    delete process.env.DATA_SET_IDS
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  // Without this guard, callers in src/add/add.ts and src/import/import.ts set
  // autoFundOptions.copies = providerIds.length, which would silently become 0.
  it('throws on a comma-only provider list rather than returning []', () => {
    expect(() => parseContextSelectionOptions({ providerIds: [','] })).toThrow(/Invalid provider ID/)
  })

  it('throws on a comma-only data set list rather than returning []', () => {
    expect(() => parseContextSelectionOptions({ dataSetIds: [',,'] })).toThrow(/Invalid data set ID/)
  })
})

describe('parseContextSelectionOptions unified ID flags', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.PROVIDER_IDS
    delete process.env.DATA_SET_IDS
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('parses the canonical repeatable --provider-id flag', () => {
    expect(parseContextSelectionOptions({ providerIds: ['7', '9'] })).toEqual({ providerIds: [7n, 9n] })
  })

  it('parses the canonical repeatable --data-set-id flag', () => {
    expect(parseContextSelectionOptions({ dataSetIds: ['12', '34'] })).toEqual({ dataSetIds: [12n, 34n] })
  })

  it('accepts the deprecated comma-separated --provider-ids alias (merged into providerIds)', () => {
    expect(parseContextSelectionOptions({ providerIds: ['1,2,3'] })).toEqual({ providerIds: [1n, 2n, 3n] })
  })

  it('accepts the deprecated single-value --data-set alias (merged into dataSetIds)', () => {
    expect(parseContextSelectionOptions({ dataSetIds: ['42'] })).toEqual({ dataSetIds: [42n] })
  })

  it('reads PROVIDER_IDS from the environment', () => {
    process.env.PROVIDER_IDS = '5,6'
    expect(parseContextSelectionOptions()).toEqual({ providerIds: [5n, 6n] })
  })

  it('reads DATA_SET_IDS from the environment', () => {
    process.env.DATA_SET_IDS = '8'
    expect(parseContextSelectionOptions()).toEqual({ dataSetIds: [8n] })
  })

  it('rejects providing both provider and data set selection', () => {
    expect(() => parseContextSelectionOptions({ providerIds: ['1'], dataSetIds: ['2'] })).toThrow(/Cannot specify both/)
  })

  it('rejects duplicate IDs', () => {
    expect(() => parseContextSelectionOptions({ providerIds: ['1', '1'] })).toThrow(/Duplicate provider ID/)
  })

  it('returns an empty selection when nothing is provided', () => {
    expect(parseContextSelectionOptions({})).toEqual({})
  })
})

describe('assertOwnerAuth', () => {
  const sessionOptions = {
    walletAddress: '0x0000000000000000000000000000000000000002',
    sessionKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
  }

  it('refuses a session key on owner-only commands, naming the command', () => {
    expect(() => assertOwnerAuth(parseCLIAuth(sessionOptions), 'payments deposit')).toThrow(
      /payments deposit needs the account owner's wallet/
    )
  })

  it('accepts a private key', () => {
    const config = parseCLIAuth({ privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' })
    expect(() => assertOwnerAuth(config, 'payments deposit')).not.toThrow()
  })

  it('refuses a view-only address, which cannot sign', () => {
    const config = parseCLIAuth({ viewAddress: '0x0000000000000000000000000000000000000002' })
    expect(() => assertOwnerAuth(config, 'payments withdraw')).toThrow(/view-only address can't sign/)
  })
})

describe('parseCLIAuth session line', () => {
  const sessionOptions = {
    walletAddress: '0xffd6000000000000000000000000000000000666',
    sessionKey: `0x${'11'.repeat(32)}`,
  }

  beforeEach(() => {
    vi.spyOn(log, 'line').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.mocked(getSessionCredentialSource).mockReset()
    vi.mocked(getSessionCredentialNetwork).mockReset()
    vi.mocked(wasSessionSkippedForViewAddress).mockReset()
  })

  const lines = () =>
    vi
      .mocked(log.line)
      .mock.calls.map((c) => String(c[0]))
      .join('\n')

  it('names the session and owner when a session credential is used', () => {
    parseCLIAuth(sessionOptions)
    expect(lines()).toContain('Using session')
    expect(lines()).toContain('0666')
    expect(lines()).not.toContain('(from ')
  })

  it('names the file the credentials came from when auto-loaded', () => {
    vi.mocked(getSessionCredentialSource).mockReturnValue('/data/session.env')
    parseCLIAuth(sessionOptions)
    expect(lines()).toContain('(from /data/session.env)')
  })

  it('names the saved login network', () => {
    vi.mocked(getSessionCredentialNetwork).mockReturnValue('calibration')
    parseCLIAuth({ ...sessionOptions, network: 'calibration' })
    expect(lines()).toContain('calibration')
    expect(lines()).not.toContain('saved login is for')
  })

  it('warns when the command runs on a network other than the saved login', () => {
    vi.mocked(getSessionCredentialNetwork).mockReturnValue('calibration')
    parseCLIAuth({ ...sessionOptions, network: 'mainnet' })
    expect(lines()).toContain('saved login is for calibration')
    expect(lines()).toContain('mainnet')
  })

  it('says when VIEW_ADDRESS kept a saved login out', () => {
    vi.mocked(wasSessionSkippedForViewAddress).mockReturnValue(true)
    parseCLIAuth({ viewAddress: '0x0000000000000000000000000000000000000002' })
    expect(lines()).toContain('Saved login ignored')
  })

  it.each([
    ['a private key', { privateKey: `0x${'11'.repeat(32)}` }],
    ['a view-only address', { viewAddress: '0x0000000000000000000000000000000000000002' }],
    ['a malformed session key', { ...sessionOptions, sessionKey: '0xnothex' }],
  ])('stays quiet for %s', (_label, options) => {
    parseCLIAuth(options)
    expect(lines()).toBe('')
  })
})
