/**
 * Action handler for `filecoin-pin session generate`.
 *
 * Deprecated: `login` now generates and saves the same keypair. Hidden from
 * help; prints a redirect and exits 1. Remove in the next major.
 */

import { CliFatal } from '../common/cli-errors.js'
import { log } from '../utils/cli-logger.js'

export function runSessionGenerate(): never {
  log.line('use `filecoin-pin login`')
  log.flush()
  throw new CliFatal('use `filecoin-pin login`')
}
