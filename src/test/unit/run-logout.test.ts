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

/** Each log line with ANSI colour codes stripped, since CI forces colour on. */
function lines(): string[] {
  return vi
    .mocked(log.line)
    .mock.calls.map((call) => String(call[0]).replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), ''))
}

describe('runLogout', () => {
  beforeEach(() => {
    vi.spyOn(log, 'line').mockImplementation(() => undefined)
    vi.spyOn(log, 'flush').mockImplementation(() => undefined)
    vi.stubEnv('CONSOLE_URL', 'https://console.test')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.mocked(readSessionFile).mockReset()
    vi.mocked(deleteSessionFile).mockReset()
  })

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

  it('says the key was only forgotten locally when it was never authorized', () => {
    vi.mocked(readSessionFile).mockReturnValue({
      sessionKey: '0xsecret',
      sessionAddress: SESSION,
      network: 'calibration',
    })
    vi.mocked(deleteSessionFile).mockReturnValue(true)

    runLogout()

    const text = lines().join('\n')
    expect(text).toContain(`Logged out: removed ${SESSION} from /data/session.env`)
    expect(text).toContain('only forgets the key on this machine')
    expect(text).not.toContain('session-keys')
  })

  it('says it was not logged in when there is no session file', () => {
    vi.mocked(readSessionFile).mockReturnValue(undefined)
    vi.mocked(deleteSessionFile).mockReturnValue(false)

    runLogout()

    const text = lines().join('\n')
    expect(text).toContain('Not logged in: no session file at /data/session.env')
    expect(text).not.toContain('Logged out')
    expect(text).not.toContain('session-keys')
  })
})
