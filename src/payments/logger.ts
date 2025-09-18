/**
 * Logging utilities for consistent output across TTY and non-TTY environments
 *
 * Provides a unified interface for logging that:
 * - Uses Clack's formatted output in TTY mode
 * - Falls back to plain console.log in non-TTY mode
 * - Maintains consistent indentation across all modes
 */

import { log as clackLog } from '@clack/prompts'
import pc from 'picocolors'

/**
 * Check if we're in TTY mode
 */
function isTTY(): boolean {
  return process.stdout.isTTY ?? false
}

/**
 * Buffer for collecting log lines to output together
 */
let lineBuffer: string[] = []

/**
 * Logger that adapts to TTY/non-TTY environments
 */
export { isTTY }

export const log = {
  /**
   * Log a plain message
   */
  message(message: string): void {
    if (isTTY()) {
      // If we have buffered lines, flush them first
      if (lineBuffer.length > 0) {
        clackLog.message(lineBuffer.join('\n'))
        lineBuffer = []
      }
      clackLog.message(message)
    } else {
      console.log(`${message}\n`)
    }
  },

  /**
   * Add a line to the buffer (for batched output in TTY mode)
   */
  line(message: string): void {
    if (isTTY()) {
      lineBuffer.push(message)
    } else {
      console.log(message)
    }
  },

  /**
   * Flush any buffered lines
   */
  flush(): void {
    if (isTTY() && lineBuffer.length > 0) {
      // Join all lines, including empty ones for controlled spacing
      clackLog.message(lineBuffer.join('\n'))
      lineBuffer = []
    }
  },

  /**
   * Log an info message
   */
  info(message: string): void {
    if (isTTY()) {
      clackLog.info(message)
    } else {
      console.log(message)
    }
  },

  /**
   * Log a success message
   */
  success(message: string): void {
    if (isTTY()) {
      clackLog.success(message)
    } else {
      console.log(message)
    }
  },

  /**
   * Log a warning message
   */
  warn(message: string): void {
    if (isTTY()) {
      clackLog.warn(message)
    } else {
      console.log(message)
    }
  },

  /**
   * Log a section with title and content
   * In TTY mode, batches output to reduce vertical space
   * In non-TTY mode, uses plain text
   */
  section(title: string, content: string | string[]): void {
    const lines = Array.isArray(content) ? content : [content]

    if (isTTY()) {
      const output = [`\n${pc.bold(title)}`, ...lines.map((line) => `  ${line}`)].join('\n')
      clackLog.message(output)
    } else {
      console.log(`\n${title}`)
      for (const line of lines) {
        console.log(`  ${line}`)
      }
    }
  },

  /**
   * Log with custom indentation
   * Adds to buffer in TTY mode for batched output
   */
  indent(message: string, level: number = 1): void {
    const indent = '  '.repeat(level)
    if (isTTY()) {
      lineBuffer.push(`${indent}${message}`)
    } else {
      console.log(`${indent}${message}`)
    }
  },

  /**
   * Log a blank line
   * In TTY mode, just adds to buffer
   */
  newline(): void {
    if (isTTY()) {
      lineBuffer.push('')
    } else {
      console.log()
    }
  },
}
