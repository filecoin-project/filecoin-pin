import { afterEach, describe, expect, it, vi } from 'vitest'
import { loginCommand } from '../../commands/login.js'
import { runLogin } from '../../login/index.js'

vi.mock('../../login/index.js', () => ({ runLogin: vi.fn(async () => 0), runLogout: vi.fn() }))

/** The options `login <args>` hands to runLogin. */
async function optionsFor(args: string[]): Promise<Record<string, unknown>> {
  vi.mocked(runLogin).mockClear()
  await loginCommand.parseAsync(args, { from: 'user' })
  const options = vi.mocked(runLogin).mock.calls[0]?.[0]
  if (options === undefined) throw new Error('runLogin was not called')
  return options as Record<string, unknown>
}

describe('login command wiring for Grants', () => {
  afterEach(() => {
    process.exitCode = undefined
  })

  it('passes --grant <text> through', async () => {
    expect(await optionsFor(['--grant', 'fgr1_abc'])).toMatchObject({ grant: 'fgr1_abc' })
  })

  it('passes --grant - through, for stdin', async () => {
    expect(await optionsFor(['--grant', '-'])).toMatchObject({ grant: '-' })
  })

  it('passes encrypt in --scopes through', async () => {
    expect(await optionsFor(['--scopes', 'createDataSet,addPieces,encrypt'])).toMatchObject({
      scopes: 'createDataSet,addPieces,encrypt',
    })
  })
})
