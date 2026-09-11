/**
 * Action handler for `filecoin-pin logout`: deletes the saved session file.
 * The on-chain grant expires on its own; the console can revoke it early.
 */

import pc from 'picocolors'
import { buildConsoleUrl, resolveConsoleUrl } from '../core/session/console-url.js'
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
  if (session?.walletAddress !== undefined) {
    log.line(
      `  The key stays authorized on chain for ${session.walletAddress} until it expires, unless it was revoked.`
    )
    log.line(`  Revoke it on the console's Session keys page:`)
    // The link on its own line, unstyled, so it copies and parses cleanly.
    log.line(`${buildConsoleUrl(resolveConsoleUrl())}/session-keys`)
    log.line(`  or with the wallet key:  filecoin-pin session revoke ${session.sessionAddress}`)
  } else {
    log.line(pc.gray('  This only forgets the key on this machine; an on-chain grant lapses on its own.'))
  }
  log.flush()
}
