/**
 * Getting a group key Grant into `login`: from `--grant <text>`, `--grant -` (stdin), or a
 * prompt the owner pastes into. Copy and paste only. The Grant opens only with this session
 * key, so it may pass through a chat or a terminal; it does reveal public metadata: the
 * owner, the session address, the group key id and the expiry.
 */

import { createInterface } from 'node:readline'
import { GRANT_PREFIX, GrantError, normalizeGrantText, type OpenedGrant } from '../common/group-key-grant.js'

/** A Grant is about 520 characters; anything this large on stdin is not one. */
export const MAX_GRANT_INPUT_BYTES = 16 * 1024

/**
 * `--grant` text, or all of piped stdin for `--grant -`.
 *
 * @throws if `-` meets a terminal (it would wait forever) or more than 16 KB.
 */
export async function readGrantArgument(
  value: string,
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
): Promise<string> {
  if (value !== '-') return value
  if (stdin.isTTY === true) {
    throw new Error('--grant - reads the Grant from a pipe: pipe the Grant in, or pass it as an argument.')
  }
  let text = ''
  for await (const chunk of stdin) {
    text += String(chunk)
    if (Buffer.byteLength(text) > MAX_GRANT_INPUT_BYTES) {
      throw new Error('--grant -: stdin holds more than 16 KB, which is not a Grant (a Grant is about 520 characters).')
    }
  }
  return text
}

/**
 * Ask for the Grant until one opens, or until the owner enters an empty line, presses
 * Ctrl-C or closes stdin to skip. A Grant the terminal split over several lines is joined:
 * an incomplete one waits for the next line, and a line starting with `fgr1_` starts over.
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
  // Ctrl-C at the prompt closes readline (its default with no SIGINT listener), which skips
  // the Grant like an empty line: the login itself is done.
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
      // A fresh paste over an unfinished one replaces it.
      text = piece.startsWith(GRANT_PREFIX) ? piece : text + piece
      try {
        return await open(text)
      } catch (error) {
        if (!(error instanceof GrantError)) throw error
        if (error.incomplete) {
          output.write('  … still incomplete: keep pasting, or press Enter to start over\n')
          continue
        }
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
