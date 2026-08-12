/**
 * Gateway failure surface for the migrate retrieval path.
 *
 * Every CID is fetched via the block-verified canonical path
 * (`gateway-blocks.ts`); this module holds the typed error those fetches
 * throw so callers can categorize failures instead of pattern-matching
 * error messages.
 */

import type { FailureCategory } from './db.js'

/**
 * Error subclass thrown by the gateway retrieval path so callers can
 * categorize failures by kind instead of pattern-matching the error message.
 */
export class GatewayError extends Error {
  status?: number
  category: FailureCategory
  constructor(message: string, opts: { status?: number | undefined; category: FailureCategory }) {
    super(message)
    this.name = 'GatewayError'
    if (opts.status != null) {
      this.status = opts.status
    }
    this.category = opts.category
  }
}
