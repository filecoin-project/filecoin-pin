/**
 * Open a URL in the user's default browser, best effort.
 *
 * Only attempted on an interactive terminal: an agent or a CI job gets the
 * printed URL and nothing else. Failures are swallowed because the URL is
 * always printed first and the flow continues without the browser.
 */

import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { isTTY } from '../utils/cli-logger.js'

function openerFor(url: string): { command: string; args: string[] } {
  switch (platform()) {
    case 'darwin':
      return { command: 'open', args: [url] }
    case 'win32':
      // Not `cmd /c start`: cmd.exe reads `&` in the query string as a
      // command separator. rundll32 gets the URL as one plain argument.
      return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
    default:
      return { command: 'xdg-open', args: [url] }
  }
}

/** Returns true when a browser launch was attempted. */
export function openBrowser(url: string): boolean {
  if (!isTTY()) return false
  const { command, args } = openerFor(url)
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => undefined)
    child.unref()
    return true
  } catch {
    return false
  }
}
