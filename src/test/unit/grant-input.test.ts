import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { OpenedGrant } from '../../common/group-key-grant.js'
import { promptForGrant } from '../../login/grant-input.js'

/** A stdout that collects what the prompt writes. */
function sink(isTTY: boolean): { stream: Writable & { isTTY: boolean }; text: () => string } {
  const chunks: string[] = []
  const stream = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk))
        callback()
      },
    }),
    { isTTY }
  )
  return { stream, text: () => chunks.join('') }
}

describe('promptForGrant', () => {
  const never = vi.fn(async (): Promise<OpenedGrant> => {
    throw new Error('nothing should be opened')
  })

  it('skips on Ctrl-C at a terminal', async () => {
    const input = new PassThrough()
    const output = sink(true)

    const result = promptForGrant(never, input, output.stream)
    input.write('\x03')

    await expect(result).resolves.toBeUndefined()
    expect(never).not.toHaveBeenCalled()
  })

  it('skips when stdin closes without a Grant', async () => {
    const input = new PassThrough()
    input.end()

    await expect(promptForGrant(never, input, sink(false).stream)).resolves.toBeUndefined()
  })
})
