import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRunInteractiveSetup, mockLogFlush, mockLogLine } = vi.hoisted(() => ({
  mockRunInteractiveSetup: vi.fn(),
  mockLogFlush: vi.fn(),
  mockLogLine: vi.fn(),
}))

vi.mock('../../payments/interactive.js', () => ({ runInteractiveSetup: mockRunInteractiveSetup }))
vi.mock('../../utils/cli-logger.js', () => ({
  log: { flush: mockLogFlush, line: mockLogLine },
}))

import { handlePaymentsSetupAction, hasExplicitInteractiveSourceOption } from '../../commands/payments.js'
import { addFundingSourceOptions } from '../../utils/cli-options.js'

const originalSourceRpcUrl = process.env.SOURCE_RPC_URL

describe('payments setup source acquisition boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.SOURCE_RPC_URL
    process.exitCode = undefined
  })

  afterEach(() => {
    if (originalSourceRpcUrl === undefined) delete process.env.SOURCE_RPC_URL
    else process.env.SOURCE_RPC_URL = originalSourceRpcUrl
    process.exitCode = undefined
  })

  it('visibly rejects an explicit source RPC option without --auto before interactive setup', async () => {
    const command = addFundingSourceOptions(new Command()).exitOverride()
    command.parse(['--source-rpc-url', 'https://rpc.example/'], { from: 'user' })

    await handlePaymentsSetupAction(
      { auto: false, rateAllowance: '1TiB/month', sourceRpcUrl: 'https://rpc.example/' },
      command
    )

    const message = 'Source acquisition options require payments setup --auto'
    expect(hasExplicitInteractiveSourceOption(command)).toBe(true)
    expect(mockRunInteractiveSetup).not.toHaveBeenCalled()
    expect(mockLogLine.mock.calls.flat().filter((line) => String(line).includes(message))).toHaveLength(1)
    expect(mockLogFlush).toHaveBeenCalledTimes(1)
    expect(process.exitCode).toBe(1)
  })

  it('keeps an ambient SOURCE_RPC_URL inert for interactive setup', async () => {
    process.env.SOURCE_RPC_URL = 'https://ambient-source-rpc.example/rpc'
    const command = addFundingSourceOptions(new Command()).exitOverride()
    command.parse([], { from: 'user' })
    const options = command.opts()

    await handlePaymentsSetupAction(
      { auto: false, rateAllowance: '1TiB/month', sourceRpcUrl: options.sourceRpcUrl },
      command
    )

    expect(hasExplicitInteractiveSourceOption(command)).toBe(false)
    expect(mockRunInteractiveSetup).toHaveBeenCalledWith(
      expect.objectContaining({ auto: false, sourceRpcUrl: 'https://ambient-source-rpc.example/rpc' })
    )
    expect(mockLogLine).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })
})
