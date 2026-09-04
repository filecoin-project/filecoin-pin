/**
 * Action handler for `filecoin-pin logout`: deletes the saved session file.
 * The on-chain grant expires on its own; the console can revoke it early.
 */

import pc from 'picocolors'
import { log } from '../utils/cli-logger.js'
import { deleteSessionFile, getSessionFilePath } from './session-file.js'

export function runLogout(): void {
  const path = getSessionFilePath()
  if (deleteSessionFile(path)) {
    log.line(`${pc.green('✓')} Logged out: removed ${path}`)
  } else {
    log.line(`${pc.gray('•')} Not logged in: no session file at ${path}`)
  }
  log.line(pc.gray('  The on-chain grant lapses on its own; revoke it early in the Filecoin Cloud console.'))
  log.flush()
}
