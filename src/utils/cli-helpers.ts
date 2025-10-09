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

/**
 * Format file size for human-readable display
 */
export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = bytes
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`
}

/**
 * Check if we can perform interactive prompts.
 *
 * TTY is not enough, we also need to be in an interactive environment.
 * CI/CD environments are not interactive.
 */
export function isInteractive(): boolean {
  return isTTY() && process.env.CI !== 'true' && process.env.GITHUB_ACTIONS !== 'true'
}
