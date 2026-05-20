/**
 * Recognize the WarmStorage `InsufficientLockupFunds` revert and turn it into
 * an actionable, user-facing message.
 *
 * The SDK surfaces this contract error only inside a multi-line, nested error
 * chain (its actionable detail ends up in the silent debug logger), so the
 * upload runners use this helper to lift the reason into the failure display.
 *
 * The revert text looks like:
 *
 *   InsufficientLockupFunds(address payer, uint256 minimumRequired, uint256 available)
 *                          (0xPAYER, 1160000000000000000, 500159722223374120)
 */

import { formatUSDFC } from '../core/utils/format.js'

export interface LockupShortfall {
  minimumRequired: bigint
  available: bigint
}

const INSUFFICIENT_LOCKUP_RE = /InsufficientLockupFunds[\s\S]*?\(\s*0x[0-9a-fA-F]+\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/

/**
 * Walk an error chain (message + nested `cause`) into a single searchable string.
 */
function collectErrorText(error: unknown, depth = 0): string {
  if (error == null || depth > 10) {
    return ''
  }
  if (typeof error === 'string') {
    return error
  }
  if (typeof error === 'object') {
    const { message, cause } = error as { message?: unknown; cause?: unknown }
    const text = typeof message === 'string' ? message : ''
    return `${text}\n${collectErrorText(cause, depth + 1)}`
  }
  return ''
}

/**
 * Parse the `minimumRequired` / `available` amounts from an `InsufficientLockupFunds`
 * revert anywhere in the error chain. Returns `null` when the error is unrelated.
 */
export function parseInsufficientLockup(error: unknown): LockupShortfall | null {
  const match = collectErrorText(error).match(INSUFFICIENT_LOCKUP_RE)
  if (match?.[1] == null || match[2] == null) {
    return null
  }
  return {
    minimumRequired: BigInt(match[1]),
    available: BigInt(match[2]),
  }
}

/**
 * Build a friendly headline and guidance for an `InsufficientLockupFunds` failure,
 * or `null` when the error is something else.
 */
export function describeLockupShortfall(error: unknown): { headline: string; hints: string[] } | null {
  const shortfall = parseInsufficientLockup(error)
  if (shortfall == null) {
    return null
  }
  return {
    headline: 'insufficient locked funds to create a data set',
    hints: [
      `Needs ${formatUSDFC(shortfall.minimumRequired)} USDFC locked, but only ${formatUSDFC(shortfall.available)} USDFC is available.`,
    ],
  }
}
