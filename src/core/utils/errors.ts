/**
 * Safely extracts an error message from an unknown error value.
 *
 * @param error - The error value to extract a message from
 * @returns The error message string, or 'Unknown error' if the error type cannot be determined
 *
 * @example
 * ```typescript
 * try {
 *   // some operation
 * } catch (error) {
 *   const message = getErrorMessage(error)
 *   logger.error(`Operation failed: ${message}`)
 * }
 * ```
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return 'Unknown error'
}
