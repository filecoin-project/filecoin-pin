/**
 * Multi-operation spinner flow manager
 *
 * Manages a spinner that can track multiple parallel operations, automatically
 * updating the spinner message as operations are added, updated, or completed.
 *
 * Usage:
 *   const flow = createSpinnerFlow(spinner)
 *   flow.addOperation('upload', 'Uploading file...')
 *   flow.addOperation('validate', 'Validating...')
 *   flow.updateOperation('upload', 'Uploading file... 50%')
 *   flow.completeOperation('upload', 'Upload complete', { type: 'success', details: {...} })
 *   flow.completeOperation('validate', 'Validation complete', { type: 'success' })
 */

import pc from 'picocolors'
import type { Spinner } from './cli-helpers.js'
import { log } from './cli-logger.js'

export type OperationStatus = 'success' | 'warning' | 'error' | 'info'

export interface OperationCompletionOptions {
  /**
   * Visual status of the completion
   * @default 'success'
   */
  type?: OperationStatus
  /**
   * Optional details section to display after completion (with title)
   */
  details?:
    | {
        title: string
        content: string[]
      }
    | undefined
  /**
   * Optional indented lines to display after the completion message
   * (no title/section header, just indented content)
   */
  afterLines?: string[]
}

/**
 * Multi-operation spinner flow manager
 */
export class MultiOperationSpinner {
  private operations: Map<string, string> = new Map()
  private spinner: Spinner | undefined
  private spinnerRunning: boolean = false

  constructor(spinner: Spinner | undefined) {
    this.spinner = spinner
  }

  /**
   * Get the combined message for all active operations
   */
  private getCombinedMessage(): string {
    return Array.from(this.operations.values())
      .filter((msg) => msg !== '')
      .join(' & ')
  }

  /**
   * Update the spinner message
   * Handles starting the spinner if needed, or updating if already running
   */
  private updateSpinner(): void {
    const message = this.getCombinedMessage()

    if (message === '') {
      // No operations - nothing to do, but don't stop spinner
      // (spinner might be running for other reasons)
      return
    }

    if (this.spinnerRunning) {
      // Spinner running, update message
      this.spinner?.message(message)
    } else {
      // Spinner not running, start it
      this.spinner?.start(message)
      this.spinnerRunning = true
    }
  }

  /**
   * Add or update an operation
   * @param id - Unique identifier for the operation
   * @param message - Message to display for this operation
   */
  addOperation(id: string, message: string): void {
    this.operations.set(id, message)
    this.updateSpinner()
  }

  /**
   * Update an existing operation's message
   * @param id - Operation identifier
   * @param message - New message
   */
  updateOperation(id: string, message: string): void {
    if (!this.operations.has(id)) {
      // Operation doesn't exist, treat as add
      this.addOperation(id, message)
      return
    }
    this.operations.set(id, message)
    this.updateSpinner()
  }

  /**
   * Mark that the spinner was started externally
   * Use this when you start the spinner outside of the flow manager
   */
  markSpinnerStarted(): void {
    this.spinnerRunning = true
  }

  /**
   * Mark that the spinner was stopped externally
   * Use this when you stop the spinner outside of the flow manager
   */
  markSpinnerStopped(): void {
    this.spinnerRunning = false
  }

  /**
   * Print a section while the spinner may be running.
   * Stops the spinner with the section title as the stop message,
   * then prints content below it. This avoids a stray empty stop
   * marker and double bar-line spacing.
   */
  printSection(title: string, content: string[]): void {
    if (this.spinnerRunning) {
      this.spinner?.stop(pc.bold(title))
      this.spinnerRunning = false
    } else {
      log.line('')
      log.line(pc.bold(title))
    }
    for (const line of content) {
      log.indent(line)
    }
    log.flush()
  }

  /**
   * Complete an operation
   * @param id - Operation identifier
   * @param message - Completion message
   * @param options - Completion options (status type and optional details)
   */
  completeOperation(id: string, message: string, options: OperationCompletionOptions = {}): void {
    if (!this.operations.has(id)) {
      // Operation doesn't exist, nothing to complete
      return
    }

    const { type = 'success', details, afterLines } = options

    // Remove from active operations
    this.operations.delete(id)

    // Format completion message with status indicator
    const statusIcon = this.getStatusIcon(type)
    const completionMessage = `${statusIcon} ${message}`

    // Stop spinner with completion message
    this.spinner?.stop(completionMessage)
    this.spinnerRunning = false

    // Display indented lines directly after completion (no section header)
    if (afterLines != null && afterLines.length > 0) {
      for (const line of afterLines) {
        log.indent(line)
      }
      log.flush()
    }

    // Display details section if provided
    if (details != null) {
      log.spinnerSection(details.title, details.content)
    }

    // Restart spinner if there are remaining operations
    const remainingMessage = this.getCombinedMessage()
    if (remainingMessage !== '') {
      this.spinner?.start(remainingMessage)
      this.spinnerRunning = true
    }
  }

  /**
   * Get the icon for a status type
   */
  private getStatusIcon(type: OperationStatus): string {
    switch (type) {
      case 'success':
        return pc.green('✓')
      case 'warning':
        return pc.yellow('⚠')
      case 'error':
        return pc.red('✗')
      case 'info':
        return pc.blue('ℹ')
      default:
        return pc.green('✓')
    }
  }
}

/**
 * Create a new multi-operation spinner flow
 * @param spinner - The spinner instance to manage
 * @returns A MultiOperationSpinner instance
 */
export function createSpinnerFlow(spinner: Spinner | undefined): MultiOperationSpinner {
  return new MultiOperationSpinner(spinner)
}
