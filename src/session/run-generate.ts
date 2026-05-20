/**
 * Action handler for `filecoin-pin session generate`.
 *
 * Local-only flow: produces a fresh session keypair on the consumer's machine
 * and prints SESSION_KEY (secret) plus SESSION_ADDRESS (public). Owner-side
 * authorization happens via `session authorize <address>`.
 */

import type { SessionKeypair } from '../core/session/index.js'
import { generateSessionKeypair } from '../core/session/index.js'
import { log } from '../utils/cli-logger.js'
import { formatSessionKeypairOutput } from './format.js'

export function runSessionGenerate(): SessionKeypair {
  const keypair = generateSessionKeypair()
  log.line(formatSessionKeypairOutput(keypair))
  log.flush()
  return keypair
}
