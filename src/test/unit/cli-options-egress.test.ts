import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EGRESS_PROVIDERS, normalizeEgressProvider } from '../../utils/cli-options-egress.js'

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

describe('normalizeEgressProvider', () => {
  it('returns "beam" by default when neither CLI nor env is set', () => {
    expect(normalizeEgressProvider(undefined, undefined, {})).toBe('beam')
  })

  it('returns the CLI value when source indicates user-provided', () => {
    expect(normalizeEgressProvider('none', 'cli', {})).toBe('none')
    expect(normalizeEgressProvider('beam', 'cli', {})).toBe('beam')
    expect(normalizeEgressProvider('none', 'env', {})).toBe('none')
  })

  it('treats Commander default value as absent (so WITH_CDN can apply)', () => {
    expect(normalizeEgressProvider('beam', 'default', { WITH_CDN: 'false' })).toBe('none')
    expect(normalizeEgressProvider('beam', 'implied', { WITH_CDN: 'false' })).toBe('none')
  })

  it('falls back to WITH_CDN=false → none when CLI value is absent', () => {
    expect(normalizeEgressProvider(undefined, undefined, { WITH_CDN: 'false' })).toBe('none')
  })

  it('falls back to WITH_CDN=true → beam when CLI value is absent', () => {
    expect(normalizeEgressProvider(undefined, undefined, { WITH_CDN: 'true' })).toBe('beam')
  })

  it('CLI flag wins over WITH_CDN env when source is user-provided', () => {
    expect(normalizeEgressProvider('none', 'cli', { WITH_CDN: 'true' })).toBe('none')
    expect(normalizeEgressProvider('beam', 'cli', { WITH_CDN: 'false' })).toBe('beam')
  })

  it('ignores WITH_CDN values other than "true"/"false"', () => {
    expect(normalizeEgressProvider(undefined, undefined, { WITH_CDN: 'yes' })).toBe('beam')
    expect(normalizeEgressProvider(undefined, undefined, { WITH_CDN: '' })).toBe('beam')
  })

  it('exposes the closed list of providers', () => {
    expect(EGRESS_PROVIDERS).toEqual(['beam', 'none'])
  })
})

import { addEgressOptions } from '../../utils/cli-options-egress.js'

describe('addEgressOptions', () => {
  const originalEgress = process.env.EGRESS_PROVIDER

  beforeEach(() => {
    delete process.env.EGRESS_PROVIDER
  })

  afterEach(() => {
    if (originalEgress === undefined) delete process.env.EGRESS_PROVIDER
    else process.env.EGRESS_PROVIDER = originalEgress
  })

  it('defaults --egress-provider to "beam"', () => {
    const command = addEgressOptions(new Command()).exitOverride()
    command.parse([], { from: 'user' })
    expect(command.opts().egressProvider).toBe('beam')
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

import { printEgressNotice, resolveEgressProviderSource } from '../../utils/cli-options-egress.js'

describe('printEgressNotice', () => {
  beforeEach(async () => {
    const { log } = await import('../../utils/cli-logger.js')
    vi.mocked(log.info).mockClear()
    vi.mocked(log.line).mockClear()
    vi.mocked(log.indent).mockClear()
    vi.mocked(log.flush).mockClear()
  })

  it('prints nothing when provider is "none"', async () => {
    printEgressNotice('none', { source: 'default' })
    const { log } = await import('../../utils/cli-logger.js')
    expect(vi.mocked(log.info)).not.toHaveBeenCalled()
    expect(vi.mocked(log.line)).not.toHaveBeenCalled()
  })

  it('prints "FilBeam (default)" header when source is "default"', async () => {
    printEgressNotice('beam', { source: 'default' })
    const { log } = await import('../../utils/cli-logger.js')
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining('Egress: FilBeam (default)'))
  })

  it('prints "FilBeam" header (no "(default)" suffix) when source is "cli"', async () => {
    printEgressNotice('beam', { source: 'cli' })
    const { log } = await import('../../utils/cli-logger.js')
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringMatching(/Egress: FilBeam(?! \(default\))/))
  })

  it('prints the four notice bullets and the disable hint', async () => {
    printEgressNotice('beam', { source: 'default' })
    const { log } = await import('../../utils/cli-logger.js')
    const indentCalls = vi.mocked(log.indent).mock.calls.map(([msg]) => msg as string)
    expect(indentCalls).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Pieces retrievable via the FilBeam CDN endpoint'),
        expect.stringContaining('Egress costs are charged'),
        expect.stringContaining('IPFS-block retrieval is not yet routed'),
        expect.stringContaining('Disable with: --egress-provider none'),
      ])
    )
    expect(vi.mocked(log.flush)).toHaveBeenCalled()
  })
})

describe('resolveEgressProviderSource', () => {
  it('returns "default" when Commander used its default and no WITH_CDN', () => {
    expect(resolveEgressProviderSource('default', {})).toBe('default')
    expect(resolveEgressProviderSource(undefined, {})).toBe('default')
  })

  it('returns "cli" when Commander reported "cli"', () => {
    expect(resolveEgressProviderSource('cli', {})).toBe('cli')
  })

  it('returns "cli" when Commander reported "env" (EGRESS_PROVIDER)', () => {
    expect(resolveEgressProviderSource('env', {})).toBe('cli')
  })

  it('returns "cli" when WITH_CDN is set explicitly even with Commander default', () => {
    expect(resolveEgressProviderSource('default', { WITH_CDN: 'true' })).toBe('cli')
    expect(resolveEgressProviderSource('default', { WITH_CDN: 'false' })).toBe('cli')
  })

  it('ignores WITH_CDN with non-boolean values', () => {
    expect(resolveEgressProviderSource('default', { WITH_CDN: 'yes' })).toBe('default')
  })

  it('treats Commander source "implied" as default', () => {
    expect(resolveEgressProviderSource('implied', {})).toBe('default')
  })
})
