/**
 * Custom error class for Filecoin Pin operations
 */
export class FilecoinPinError extends Error {
  constructor(message, code, details = {}) {
    super(message)
    this.name = 'FilecoinPinError'
    this.code = code
    this.details = details
  }
}

/**
 * Error codes for different failure scenarios
 */
export const ERROR_CODES = {
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  INVALID_PRIVATE_KEY: 'INVALID_PRIVATE_KEY',
  INVALID_INPUT: 'INVALID_INPUT',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  CACHE_ERROR: 'CACHE_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
}

/**
 * Handle and format errors for user display
 * @param {Error} error - The error to handle
 * @param {Object} context - Additional context for error handling
 */
export function handleError(error, context = {}) {
  console.error('Upload failed:', error?.message || error)

  // Add context-specific error handling
  if (error.code === ERROR_CODES.INSUFFICIENT_FUNDS) {
    console.error('💡 Tip: Check your wallet balance and ensure you have enough USDFC tokens.')
  } else if (error.code === ERROR_CODES.PROVIDER_UNAVAILABLE) {
    console.error('💡 Tip: Try again later or specify a different provider address.')
  } else if (error.code === ERROR_CODES.INVALID_PRIVATE_KEY) {
    console.error('💡 Tip: Ensure your private key is valid.')
  }

  // Log context if available
  if (Object.keys(context).length > 0) {
    console.error('Context:', context)
  }
}
