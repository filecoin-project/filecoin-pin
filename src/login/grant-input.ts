/**
 * Getting a group key Grant into `login`: from `--grant <text>`, `--grant -` (stdin), or a
 * prompt the owner pastes into. Copy and paste only: the Grant opens only with this
 * session key, so it may pass through a chat or a terminal in the clear.
 */

import { createInterface } from 'node:readline'
import { GrantError, normalizeGrantText, type OpenedGrant } from '../common/group-key-grant.js'

/** `--grant` text, or all of stdin for `--grant -`. */
export async function readGrantArgument(value: string, stdin: NodeJS.ReadableStream): Promise<string> {
  if (value !== '-') return value
  let text = ''
  for await (const chunk of stdin) text += String(chunk)
  return text
}

/**
 * Ask for the Grant until one opens, or until the owner enters an empty line, presses
 * Ctrl-C or closes stdin to skip. A Grant the terminal split over several lines is joined: an incomplete
 * one waits for the next line instead of failing.
 *
 * @returns the opened Grant, or undefined when skipped
 */
export async function promptForGrant(
  open: (text: string) => Promise<OpenedGrant>,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream
): Promise<OpenedGrant | undefined> {
  // Raw mode on a terminal (readline picks it from `output`): no 1024-byte canonical line limit.
  const readline = createInterface({ input, output })
  // Ctrl-C at the prompt skips the Grant, like an empty line: the login itself is done.
  readline.on('SIGINT', () => readline.close())
  const ask = (): void => {
    output.write('  Paste the Grant (or press Enter to skip): ')
  }
  let text = ''
  ask()
  try {
    for await (const line of readline) {
      const piece = normalizeGrantText(line)
      if (piece === '') {
        if (text === '') return undefined
        output.write('  ✗ The Grant is incomplete; copy it again from the console.\n')
        text = ''
        ask()
        continue
      }
      text += piece
      try {
        return await open(text)
      } catch (error) {
        if (!(error instanceof GrantError)) throw error
        if (error.incomplete) continue
        output.write(`  ✗ ${error.message}\n`)
        text = ''
        ask()
      }
    }
    return undefined
  } finally {
    readline.close()
  }
}
