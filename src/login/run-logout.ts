/**
 * Action handler for `filecoin-pin logout`: deletes the saved session file.
 * The on-chain grant expires on its own; the console can revoke it early.
 */

import pc from 'picocolors'
import { buildConsoleUrl, buildRevokeUrl, resolveConsoleUrl } from '../core/session/console-url.js'
import { log } from '../utils/cli-logger.js'
import { deleteSessionFile, getSessionFilePath, readSessionFile } from './session-file.js'

export function runLogout(): void {
  const path = getSessionFilePath()
  const session = readSessionFile(path)
  if (deleteSessionFile(path)) {
    const key = session ? ` ${session.sessionAddress}` : ''
    log.line(`${pc.green('✓')} Logged out: removed${key} from ${path}`)
  } else {
    log.line(`${pc.gray('•')} Not logged in: no session file at ${path}`)
  }
  if (session !== undefined) {
    // No wallet saved does not mean never authorized: `login --no-wait` exits
    // before the grant, and the owner may have approved since.
    log.line(
      session.walletAddress === undefined
        ? '  If you approved this key, it stays authorized on chain until it expires, unless it was revoked.'
        : `  The key stays authorized on chain for ${session.walletAddress} until it expires, unless it was revoked.`
    )
    // A link the console can place opens its revoke dialog on this key; one it
    // cannot place (devnet, a custom RPC, a file with no network) would be
    // refused, so the page itself is printed instead.
    const consoleUrl = resolveConsoleUrl()
    const revokeUrl = buildRevokeUrl(consoleUrl, session.sessionAddress, session.network)
    log.line(`  Revoke it on the console's Session keys page:`)
    // The link on its own line, unstyled, so it copies and parses cleanly.
    log.line(revokeUrl ?? `${buildConsoleUrl(consoleUrl)}/session-keys`)
    log.line(`  or with the wallet key:  filecoin-pin session revoke ${session.sessionAddress}`)
  }
  log.flush()
}
