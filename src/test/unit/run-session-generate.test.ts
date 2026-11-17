import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionCommand } from '../../commands/session.js'
import { CliFatal } from '../../common/cli-errors.js'
import { runSessionGenerate } from '../../session/run-generate.js'
import { log } from '../../utils/cli-logger.js'

describe('session generate deprecation', () => {
  beforeEach(() => {
    vi.spyOn(log, 'line').mockImplementation(() => undefined)
    vi.spyOn(log, 'flush').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prints the login redirect and does not emit a keypair', () => {
    expect(() => runSessionGenerate()).toThrow(CliFatal)
    expect(vi.mocked(log.line).mock.calls.map(([line]) => String(line))).toEqual(['use `filecoin-pin login`'])
    expect(log.flush).toHaveBeenCalled()
  })

  it('is hidden from session help', () => {
    const help = sessionCommand.helpInformation()
    expect(help).not.toMatch(/^ {2}generate\b/m)
  })
})
