import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runInteractiveSetup } from '../../payments/interactive.js'

const { mockPassword, mockIsCancel, mockIsTTY } = vi.hoisted(() => ({
  mockPassword: vi.fn(),
  mockIsCancel: vi.fn(() => false),
  mockIsTTY: vi.fn(() => true),
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
})
