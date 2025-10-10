/**
 * Custom error class for Filecoin Pin operations
 */
export class FilecoinPinError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {Object} [details={}]
   */
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
  MAX_BALANCE_EXCEEDED: 'MAX_BALANCE_EXCEEDED',
  MAX_BALANCE_REACHED: 'MAX_BALANCE_REACHED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  INVALID_PRIVATE_KEY: 'INVALID_PRIVATE_KEY',
  INVALID_INPUT: 'INVALID_INPUT',
  CAR_CREATE_FAILED: 'CAR_CREATE_FAILED',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  CACHE_ERROR: 'CACHE_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
}

/**
 * Get error message safely
 * @param {unknown} error - The error to get message from
 * @returns {string} Error message
 */
export function getErrorMessage(error) {
  if (error !== null && typeof error === 'object' && 'message' in error) {
    return /** @type {{message: string}} */ (error).message
  }
  return String(error)
}

/**
 * Handle and format errors for user display
 * @param {Error | FilecoinPinError} error - The error to handle
 * @param {Object} context - Additional context for error handling
 */
export function handleError(error, context = {}) {
  console.error('Upload failed:', getErrorMessage(error))

  // Add context-specific error handling
  // Check if error has a code property (FilecoinPinError)
  if ('code' in error) {
    if (error.code === ERROR_CODES.INSUFFICIENT_FUNDS) {
      console.error('💡 Tip: Check your wallet balance and ensure you have enough USDFC tokens.')
    } else if (error.code === ERROR_CODES.MAX_BALANCE_EXCEEDED) {
      console.error('💡 Tip: Review your filecoinPayBalanceLimit to allow larger deposits, or lower minStorageDays.')
    } else if (error.code === ERROR_CODES.MAX_BALANCE_REACHED) {
      console.error(
        '💡 Tip: Current balance already meets your filecoinPayBalanceLimit. Upload will proceed without additional deposits.'
      )
    } else if (error.code === ERROR_CODES.PROVIDER_UNAVAILABLE) {
      console.error('💡 Tip: Try again later or specify a different provider address.')
    } else if (error.code === ERROR_CODES.INVALID_PRIVATE_KEY) {
      console.error('💡 Tip: Ensure your private key is valid.')
    }
  }

  // Log context if available
  if (Object.keys(context).length > 0) {
    console.error('Context:', context)
  }
}
