/**
 * Action handler for `filecoin-pin logout`: deletes the saved session file.
 * The on-chain grant expires on its own; the console can revoke it early.
 */

import pc from 'picocolors'
import { buildRevokeUrl, resolveConsoleUrl } from '../core/session/console-url.js'
import { log } from '../utils/cli-logger.js'
import { deleteSessionFile, getSessionFilePath, readSessionFile } from './session-file.js'
import { getSettingsFilePath, privateUploadsByDefault } from './settings-file.js'

/** Whether settings.env turns private uploads on; an unreadable file counts as on, as add treats it. */
function privateUploadsSaved(): boolean {
  try {
    return privateUploadsByDefault(getSettingsFilePath(), {})
  } catch {
    return true
  }
}

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
    log.line(`  Revoke it on the console's Session keys page:`)
    // The link on its own line, unstyled, so it copies and parses cleanly.
    log.line(buildRevokeUrl(resolveConsoleUrl(), session.sessionAddress, session.network))
    log.line(`  or with the wallet key:  filecoin-pin session revoke ${session.sessionAddress}`)
  }
  // A preference, not a credential: it stays, but say so, since the next add is still private.
  if (privateUploadsSaved()) {
    log.line(
      `${pc.gray('•')} Private uploads are still on (${getSettingsFilePath()}): login --no-private-uploads turns them off`
    )
  }
  log.flush()
}
