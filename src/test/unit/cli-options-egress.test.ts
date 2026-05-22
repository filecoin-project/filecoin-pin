import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addEgressOptions, EGRESS_PROVIDERS, printEgressNotice } from '../../utils/cli-options-egress.js'

vi.mock('../../utils/cli-logger.js', () => ({
  log: {
    warn: vi.fn(),
    info: vi.fn(),
    line: vi.fn(),
    indent: vi.fn(),
    newline: vi.fn(),
    flush: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    section: vi.fn(),
    spinnerSection: vi.fn(),
  },
}))

describe('EGRESS_PROVIDERS', () => {
  it('exposes the closed list of providers', () => {
    expect(EGRESS_PROVIDERS).toEqual(['beam', 'none'])
  })
})

describe('addEgressOptions', () => {
  const originalEgress = process.env.EGRESS_PROVIDER

  beforeEach(() => {
    delete process.env.EGRESS_PROVIDER
  })

  afterEach(() => {
    if (originalEgress === undefined) delete process.env.EGRESS_PROVIDER
    else process.env.EGRESS_PROVIDER = originalEgress
  })

  it('leaves --egress-provider undefined when neither flag nor env is set (default applied later)', () => {
    const command = addEgressOptions(new Command()).exitOverride()
    command.parse([], { from: 'user' })
    expect(command.opts().egressProvider).toBeUndefined()
  })

  it('reads explicit --egress-provider value', () => {
    const command = addEgressOptions(new Command()).exitOverride()
    command.parse(['--egress-provider', 'none'], { from: 'user' })
    expect(command.opts().egressProvider).toBe('none')
  })

  it('reads --egress-provider from EGRESS_PROVIDER env var', () => {
    process.env.EGRESS_PROVIDER = 'none'
    const command = addEgressOptions(new Command()).exitOverride()
    command.parse([], { from: 'user' })
    expect(command.opts().egressProvider).toBe('none')
  })

  it('rejects invalid --egress-provider values', () => {
    const command = addEgressOptions(new Command()).exitOverride()
    expect(() => command.parse(['--egress-provider', 'banana'], { from: 'user' })).toThrow(/allowed choices/i)
  })
})

describe('printEgressNotice', () => {
  beforeEach(async () => {
    const { log } = await import('../../utils/cli-logger.js')
    vi.mocked(log.info).mockClear()
    vi.mocked(log.line).mockClear()
    vi.mocked(log.indent).mockClear()
    vi.mocked(log.flush).mockClear()
  })

  it('prints nothing when provider is "none"', async () => {
    printEgressNotice('none')
    const { log } = await import('../../utils/cli-logger.js')
    expect(vi.mocked(log.info)).not.toHaveBeenCalled()
    expect(vi.mocked(log.line)).not.toHaveBeenCalled()
  })

  it('prints "Egress: FilBeam" header when provider is "beam"', async () => {
    printEgressNotice('beam')
    const { log } = await import('../../utils/cli-logger.js')
    expect(vi.mocked(log.info)).toHaveBeenCalledWith('Egress: FilBeam')
  })

  it('prints the cost, scope, and disable bullets', async () => {
    printEgressNotice('beam')
    const { log } = await import('../../utils/cli-logger.js')
    const indentCalls = vi.mocked(log.indent).mock.calls.map(([msg]) => msg as string)
    expect(indentCalls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Egress consumes the data set owner's locked-up funds"),
        expect.stringContaining('piece/CAR retrieval only, not IPFS blocks'),
        expect.stringContaining('Disable: --egress-provider none'),
      ])
    )
    expect(vi.mocked(log.flush)).toHaveBeenCalled()
  })
})
