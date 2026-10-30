import { beforeEach, describe, expect, it, vi } from 'vitest'

const clack = vi.hoisted(() => ({ start: vi.fn(), message: vi.fn(), stop: vi.fn(), clear: vi.fn() }))
vi.mock('@clack/prompts', () => ({ spinner: () => clack }))
vi.mock('../../utils/cli-logger.js', () => ({ isTTY: () => true, log: { message: vi.fn() } }))

const { createSpinner } = await import('../../utils/cli-helpers.js')
const { log } = await import('../../utils/cli-logger.js')

describe('createSpinner on a terminal', () => {
  beforeEach(() => vi.clearAllMocks())

  it('stops a running spinner with its message', () => {
    const spinner = createSpinner()
    spinner.start('Working...')
    spinner.stop('done')
    expect(clack.stop).toHaveBeenCalledWith('done')
    expect(log.message).not.toHaveBeenCalled()
  })

  // clack prints nothing for a spinner that is not running, which lost every early failure's reason.
  it('prints the message when the spinner never started, or already stopped', () => {
    const spinner = createSpinner()
    spinner.stop('✗ Get failed: early')
    spinner.start('Working...')
    spinner.stop('✓ step')
    spinner.stop('✗ later')
    expect(clack.stop).toHaveBeenCalledTimes(1)
    expect(vi.mocked(log.message).mock.calls).toEqual([['✗ Get failed: early'], ['✗ later']])
  })
})
