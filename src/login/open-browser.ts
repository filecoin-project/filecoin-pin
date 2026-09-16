/**
 * Open a URL in the user's default browser, best effort.
 *
 * Only attempted on an interactive terminal, and never when `BROWSER=none`:
 * an agent or a CI job gets the printed URL and nothing else. Failures are swallowed because the URL is
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

/** Credentials that must not ride along into the browser's environment. */
const SECRET_ENV_VARS = ['PRIVATE_KEY', 'SESSION_KEY', 'WALLET_ADDRESS', 'VIEW_ADDRESS'] as const

/** The current environment without any credential, for child processes. */
export function environmentWithoutSecrets(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env }
  for (const name of SECRET_ENV_VARS) delete copy[name]
  return copy
}

/** Returns true when a browser launch was attempted. */
export function openBrowser(url: string): boolean {
  if (!isTTY() || process.env.BROWSER === 'none') return false
  const { command, args } = openerFor(url)
  try {
    // xdg-open and friends hand the environment to the browser; a session
    // key auto-loaded into process.env must not travel with it.
    const child = spawn(command, args, { detached: true, stdio: 'ignore', env: environmentWithoutSecrets() })
    child.on('error', () => undefined)
    child.unref()
    return true
  } catch {
    return false
  }
}
