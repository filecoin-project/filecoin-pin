import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runInteractiveSetup } from '../../payments/interactive.js'

const { mockPassword, mockIsCancel, mockIsTTY, mockParseCLIAuth, mockInitializeSynapse } = vi.hoisted(() => ({
  mockPassword: vi.fn(),
  mockIsCancel: vi.fn(() => false),
  mockIsTTY: vi.fn(() => true),
  mockParseCLIAuth: vi.fn(async (_options: { sessionKey?: string; privateKey?: string }) => ({})),
  // Throw right after auth resolves so the flow stops before any network work.
  mockInitializeSynapse: vi.fn(async () => {
    throw new Error('__stop_after_auth__')
  }),
}))

vi.mock('@clack/prompts', () => ({
  cancel: vi.fn(),
  confirm: vi.fn(),
  isCancel: mockIsCancel,
  password: mockPassword,
  text: vi.fn(),
}))
vi.mock('../../utils/cli-helpers.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  createSpinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
}))
vi.mock('../../utils/cli-logger.js', () => ({
  isTTY: mockIsTTY,
  log: { line: vi.fn(), flush: vi.fn(), indent: vi.fn() },
}))
vi.mock('../../utils/cli-auth.js', () => ({ parseCLIAuth: mockParseCLIAuth }))
vi.mock('../../core/synapse/index.js', () => ({
  initializeSynapse: mockInitializeSynapse,
  getClientAddress: vi.fn(() => '0x0000000000000000000000000000000000000000'),
}))

describe('runInteractiveSetup exit codes', () => {
  const originalPrivateKey = process.env.PRIVATE_KEY

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTTY.mockReturnValue(true)
    delete process.env.PRIVATE_KEY
    process.exitCode = 0
  })

  afterEach(() => {
    process.exitCode = 0
    if (originalPrivateKey === undefined) delete process.env.PRIVATE_KEY
    else process.env.PRIVATE_KEY = originalPrivateKey
  })

  it('exits with code 2 when the private-key prompt is cancelled', async () => {
    const cancelSymbol = Symbol('clack:cancel')
    mockPassword.mockResolvedValueOnce(cancelSymbol)
    mockIsCancel.mockReturnValueOnce(true)

    await runInteractiveSetup({} as any)

    expect(process.exitCode).toBe(2)
  })

  it('does not prompt for a private key when a complete session key is supplied', async () => {
    await runInteractiveSetup({ walletAddress: '0xowner', sessionKey: '0xsess', network: 'calibration' } as any).catch(
      () => undefined
    )

    expect(mockPassword).not.toHaveBeenCalled()
    expect(mockParseCLIAuth).toHaveBeenCalledTimes(1)
  })

  it('still prompts for a private key when no auth mode is supplied', async () => {
    mockPassword.mockResolvedValueOnce('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')

    await runInteractiveSetup({ network: 'calibration' } as any).catch(() => undefined)

    expect(mockPassword).toHaveBeenCalledTimes(1)
  })

  it('still prompts when only a view address is supplied (read-only cannot run setup)', async () => {
    mockPassword.mockResolvedValueOnce('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')

    await runInteractiveSetup({ viewAddress: '0xreadonly', network: 'calibration' } as any).catch(() => undefined)

    expect(mockPassword).toHaveBeenCalledTimes(1)
  })

  it('still prompts when only a lone wallet-address is supplied (incomplete session key)', async () => {
    mockPassword.mockResolvedValueOnce('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')

    await runInteractiveSetup({ walletAddress: '0xowner', network: 'calibration' } as any).catch(() => undefined)

    expect(mockPassword).toHaveBeenCalledTimes(1)
  })
})
