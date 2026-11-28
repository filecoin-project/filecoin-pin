/**
 * Action handler for `filecoin-pin logout`: deletes the saved session file.
 * The on-chain grant expires on its own; the console can revoke it early.
 */

import pc from 'picocolors'
import { buildRevokeUrl, consoleNetworkSlug, resolveConsoleUrl } from '../core/session/console-url.js'
import { type NetworkCliOptions, resolveNetwork } from '../session/resolve-network.js'
import { log } from '../utils/cli-logger.js'
import { deleteSessionFile, getSessionFilePath, readSessionFile } from './session-file.js'

export async function runLogout({ network, rpcUrl }: NetworkCliOptions = {}): Promise<void> {
  const path = getSessionFilePath()
  const session = readSessionFile(path)
  if (session !== undefined && (network !== undefined || rpcUrl !== undefined)) {
    if (session.network === undefined) {
      throw new Error('The saved session has no recorded network. Run logout without network flags to remove it.')
    }
    const requested = rpcUrl === undefined ? network : consoleNetworkSlug((await resolveNetwork({ rpcUrl })).chain.id)
    if (session.network !== requested) {
      throw new Error(`The saved session belongs to ${session.network}. Use that network to log out.`)
    }
  }
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
  log.flush()
}
