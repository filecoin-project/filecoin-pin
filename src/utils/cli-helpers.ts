/**
 * Shared CLI helper utilities for consistent command-line experience
 */

import {
  cancel as clackCancel,
  intro as clackIntro,
  outro as clackOutro,
  spinner as clackSpinner,
} from '@clack/prompts'
import { isTTY, log } from './cli-logger.js'

/**
 * Spinner interface for progress indication
 * Works in both TTY and non-TTY environments
 */
export type Spinner = {
  start: (msg: string) => void
  message: (msg: string) => void
  stop: (msg?: string) => void
  clear: () => void
}

/**
 * Creates a spinner that works in both TTY and non-TTY environments
 *
 * In TTY mode: Uses @clack/prompts spinner for nice visual feedback
 * In non-TTY mode: Prints simple status messages without ANSI codes
 */
export function createSpinner(): Spinner {
  if (isTTY()) {
    // Use the real spinner for TTY
    return clackSpinner()
  } else {
    // Non-TTY fallback - only print completion messages
    return {
      start(_msg: string) {
        // Don't print start messages in non-TTY
      },
      message(_msg: string) {
        // Don't print progress messages in non-TTY
      },
      stop(msg?: string) {
        if (msg) {
          // Only print the final completion message
          log.message(msg)
        }
      },
      clear() {
        // No-op in non-TTY
      },
    }
  }
}

/**
 * Show intro message with proper TTY handling
 */
export function intro(message: string): void {
  if (isTTY()) {
    clackIntro(message)
  } else {
    log.message(message)
  }
}

/**
 * Display a cancellation/error message
 * In TTY mode, uses clack's cancel for nice formatting
 * In non-TTY mode, prints to stderr
 */
export function cancel(message: string): void {
  if (isTTY()) {
    clackCancel(message)
  } else {
    console.error(message)
  }
}

/**
 * Display a success/completion message
 * In TTY mode, uses clack's outro for nice formatting
 * In non-TTY mode, prints to stdout
 */
export function outro(message: string): void {
  if (isTTY()) {
    clackOutro(message)
  } else {
    console.log(message)
  }
}

const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
/**
 * Format file size for human-readable display
 */
export function formatFileSize(bytes: number | bigint): string {
  if (typeof bytes === 'bigint') {
    return formatFileSizeBigInt(bytes)
  }
  let size = bytes
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`
}

function formatFileSizeBigInt(bytes: bigint): string {
  let unitIndex = 0
  let divisor = 1n

  while (bytes >= divisor * 1024n && unitIndex < units.length - 1) {
    divisor *= 1024n
    unitIndex++
  }

  const divisorNumber = Number(divisor)
  const asNumber = Number(bytes) / divisorNumber
  const sizeFloat =
    Number.isFinite(asNumber) && asNumber > 0
      ? asNumber
      : Number(bytes / divisor) + Number(bytes % divisor) / divisorNumber

  return `${sizeFloat.toFixed(1)} ${units[unitIndex]}`
}

/**
 * Check if we can perform interactive prompts.
 *
 * Prompts (and the piece-status pager) read keystrokes, so stdin must be a TTY
 * too. Checking stdout alone lets a piped stdin (e.g. `cmd < /dev/null`) reach
 * a prompt that then hangs or, for the raw-mode pager, throws.
 *
 * TTY is not enough, we also need to be in an interactive environment.
 * CI/CD environments are not interactive.
 */
export function isInteractive(): boolean {
  return isTTY() && process.stdin.isTTY === true && process.env.CI !== 'true' && process.env.GITHUB_ACTIONS !== 'true'
}

// Decimal spellings (kb, mb, ...) are accepted as binary aliases: flag sizes
// are power-of-two territory and rejecting `32GB` helps nobody.
const SIZE_UNITS: Record<string, bigint> = {
  b: 1n,
  k: 1024n,
  kb: 1024n,
  kib: 1024n,
  m: 1024n ** 2n,
  mb: 1024n ** 2n,
  mib: 1024n ** 2n,
  g: 1024n ** 3n,
  gb: 1024n ** 3n,
  gib: 1024n ** 3n,
  t: 1024n ** 4n,
  tb: 1024n ** 4n,
  tib: 1024n ** 4n,
}

/**
 * Parse a size flag like "32GiB", "1MiB", or a raw byte count "34359738368".
 * The inverse of `formatFileSize` above.
 */
export function parseSize(input: string): bigint {
  const trimmed = input.trim().toLowerCase()
  const match = trimmed.match(/^(\d+)\s*([a-z]*)$/)
  if (match?.[1] == null) {
    throw new Error(`invalid size: ${input}`)
  }
  const value = BigInt(match[1])
  const unit = match[2] == null || match[2] === '' ? 'b' : match[2]
  const multiplier = SIZE_UNITS[unit]
  if (multiplier == null) {
    throw new Error(`unknown size unit "${unit}" in ${input}`)
  }
  return value * multiplier
}

/** Parse a positive integer flag value; throws a clear error for missing or non-positive input. */
export function parsePositiveInt(raw: string | undefined, flag: string): number {
  if (raw == null) {
    throw new Error(`${flag} requires a value`)
  }
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || String(n) !== raw.trim()) {
    throw new Error(`${flag} must be a positive integer (got ${JSON.stringify(raw)})`)
  }
  return n
}
