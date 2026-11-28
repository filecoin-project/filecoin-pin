import { calibration } from '@filoz/synapse-sdk'
import { http } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logoutCommand } from '../../commands/login.js'
import { runLogout } from '../../login/run-logout.js'
import { deleteSessionFile, readSessionFile } from '../../login/session-file.js'
import { resolveNetwork } from '../../session/resolve-network.js'
import { log } from '../../utils/cli-logger.js'

vi.mock('../../login/session-file.js', () => ({
  getSessionFilePath: () => '/data/session.env',
  readSessionFile: vi.fn(),
  deleteSessionFile: vi.fn(),
}))
vi.mock('../../session/resolve-network.js', () => ({ resolveNetwork: vi.fn() }))

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
    vi.mocked(resolveNetwork).mockReset()
  })

  it('prints a revoke link that names the key, on its own line, for an authorized key', async () => {
    vi.mocked(readSessionFile).mockReturnValue({
      sessionKey: '0xsecret',
      sessionAddress: SESSION,
      walletAddress: OWNER,
      network: 'calibration',
    })
    vi.mocked(deleteSessionFile).mockReturnValue(true)

    await runLogout()

    expect(lines()).toContain(
      `https://console.test/console/session-keys?revoke=${SESSION.toLowerCase()}&network=calibration`
    )
    expect(lines().join('\n')).toContain(`session revoke ${SESSION}`)
  })

  it('accepts --network on the command and logs out of the matching saved session', async () => {
    vi.mocked(readSessionFile).mockReturnValue({
      sessionKey: '0xsecret',
      sessionAddress: SESSION,
      network: 'calibration',
    })
    vi.mocked(deleteSessionFile).mockReturnValue(true)

    await logoutCommand.exitOverride().parseAsync(['--network', 'calibnet'], { from: 'user' })

    expect(deleteSessionFile).toHaveBeenCalledWith('/data/session.env')
    expect(lines()).toContain(
      `https://console.test/console/session-keys?revoke=${SESSION.toLowerCase()}&network=calibration`
    )
  })

  it('keeps the saved session when it belongs to a different network', async () => {
    vi.mocked(readSessionFile).mockReturnValue({
      sessionKey: '0xsecret',
      sessionAddress: SESSION,
      network: 'calibration',
    })

    await expect(runLogout({ network: 'mainnet' })).rejects.toThrow('The saved session belongs to calibration')

    expect(deleteSessionFile).not.toHaveBeenCalled()
  })

  it('uses the RPC chain before removing a saved session', async () => {
    vi.mocked(readSessionFile).mockReturnValue({
      sessionKey: '0xsecret',
      sessionAddress: SESSION,
      network: 'calibration',
    })
    vi.mocked(deleteSessionFile).mockReturnValue(true)
    const rpcUrl = 'https://rpc.example'
    vi.mocked(resolveNetwork).mockResolvedValue({ chain: calibration, rpcUrl, transport: http(rpcUrl) })

    await runLogout({ rpcUrl })

    expect(resolveNetwork).toHaveBeenCalledWith({ rpcUrl })
    expect(deleteSessionFile).toHaveBeenCalledWith('/data/session.env')
  })

  it.each([
    ['a network the console has no page for', 'devnet'],
    ['a session file that recorded no network', undefined],
  ])('falls back to the plain page for %s', async (_case, network) => {
    vi.mocked(readSessionFile).mockReturnValue({
      sessionKey: '0xsecret',
      sessionAddress: SESSION,
      walletAddress: OWNER,
      ...(network === undefined ? {} : { network }),
    })
    vi.mocked(deleteSessionFile).mockReturnValue(true)

    await runLogout()

    // A link the console would refuse is worse than no link.
    expect(lines()).toContain('https://console.test/console/session-keys')
    expect(lines().join('\n')).not.toContain('revoke=')
  })

  it('still prints the revoke link when no wallet was saved, since --no-wait exits before the grant', async () => {
    vi.mocked(readSessionFile).mockReturnValue({
      sessionKey: '0xsecret',
      sessionAddress: SESSION,
      network: 'calibration',
    })
    vi.mocked(deleteSessionFile).mockReturnValue(true)

    await runLogout()

    const text = lines().join('\n')
    expect(text).toContain(`Logged out: removed ${SESSION} from /data/session.env`)
    expect(text).toContain('If you approved this key')
    expect(lines()).toContain(
      `https://console.test/console/session-keys?revoke=${SESSION.toLowerCase()}&network=calibration`
    )
  })

  it('says it was not logged in when there is no session file', async () => {
    vi.mocked(readSessionFile).mockReturnValue(undefined)
    vi.mocked(deleteSessionFile).mockReturnValue(false)

    await runLogout()

    const text = lines().join('\n')
    expect(text).toContain('Not logged in: no session file at /data/session.env')
    expect(text).not.toContain('Logged out')
    expect(text).not.toContain('session-keys')
  })
})
