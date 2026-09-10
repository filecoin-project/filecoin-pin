import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runLogout } from '../../login/run-logout.js'
import { deleteSessionFile, readSessionFile } from '../../login/session-file.js'
import { log } from '../../utils/cli-logger.js'

vi.mock('../../login/session-file.js', () => ({
  getSessionFilePath: () => '/data/session.env',
  readSessionFile: vi.fn(),
  deleteSessionFile: vi.fn(),
}))

const SESSION = '0x00000000000000000000000000000000000000bb'
const OWNER = '0x00000000000000000000000000000000000000aa'

describe('runLogout', () => {
  beforeEach(() => {
    vi.spyOn(log, 'line').mockImplementation(() => undefined)
    vi.spyOn(log, 'flush').mockImplementation(() => undefined)
    process.env.CONSOLE_URL = 'https://console.test'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.mocked(readSessionFile).mockReset()
    vi.mocked(deleteSessionFile).mockReset()
    delete process.env.CONSOLE_URL
  })

  const lines = () => vi.mocked(log.line).mock.calls.map((c) => String(c[0]))

  it('prints the console session-keys link on its own line for an authorized key', () => {
    vi.mocked(readSessionFile).mockReturnValue({
      sessionKey: '0xsecret',
      sessionAddress: SESSION,
      walletAddress: OWNER,
      network: 'calibration',
    })
    vi.mocked(deleteSessionFile).mockReturnValue(true)

    runLogout()

    expect(lines()).toContain('https://console.test/console/session-keys')
    expect(lines().join('\n')).toContain(`session revoke ${SESSION}`)
  })

  it('says nothing about revoking when the key was never authorized', () => {
    vi.mocked(readSessionFile).mockReturnValue({
      sessionKey: '0xsecret',
      sessionAddress: SESSION,
      network: 'calibration',
    })
    vi.mocked(deleteSessionFile).mockReturnValue(true)

    runLogout()

    expect(lines().join('\n')).not.toContain('session-keys')
  })
})
