import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runSessionAuthorize } from '../../session/run-authorize.js'

const { mockConfirm, mockIsCancel, mockIsInteractive, mockResolveNetwork } = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockIsCancel: vi.fn(() => false),
  mockIsInteractive: vi.fn(() => true),
  mockResolveNetwork: vi.fn(async () => ({ chain: { name: 'calibration', id: 314159 }, transport: {} })),
}))

vi.mock('@clack/prompts', () => ({ confirm: mockConfirm, isCancel: mockIsCancel }))
vi.mock('../../utils/cli-helpers.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  createSpinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  isInteractive: mockIsInteractive,
}))
vi.mock('../../utils/cli-logger.js', () => ({
  log: { section: vi.fn(), flush: vi.fn() },
}))
vi.mock('../../session/resolve-network.js', () => ({ resolveNetwork: mockResolveNetwork }))
vi.mock('viem/accounts', () => ({
  privateKeyToAccount: vi.fn(() => ({ address: '0x1111111111111111111111111111111111111111' })),
}))

describe('runSessionAuthorize exit codes', () => {
  const baseOptions = {
    privateKey: `0x${'a'.repeat(64)}`,
    sessionAddress: '0x2222222222222222222222222222222222222222',
    validityDays: '10',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsInteractive.mockReturnValue(true)
    mockIsCancel.mockReturnValue(false)
    process.exitCode = 0
  })

  afterEach(() => {
    process.exitCode = 0
  })

  it('exits with code 2 and returns undefined when the user declines', async () => {
    mockConfirm.mockResolvedValueOnce(false)

    const result = await runSessionAuthorize(baseOptions as any)

    expect(result).toBeUndefined()
    expect(process.exitCode).toBe(2)
  })
})
