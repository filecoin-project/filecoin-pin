/**
 * HTTP Logger implementation for filecoin-pin
 *
 * Logs HTTP requests and responses to Curio PDP servers using pino logger.
 * HTTP logs appear at debug level, so they will be visible when debug/verbose logging is enabled.
 */
import type { Logger } from 'pino'

/**
 * HTTP Logger interface for logging HTTP requests and responses
 * This matches the interface in @filoz/synapse-core
 */
export interface HTTPLogger {
  logRequest(method: string, url: string): void
  logResponse(method: string, url: string, statusCode: number): void
}

export class FilecoinPinHTTPLogger implements HTTPLogger {
  constructor(private readonly logger: Logger) {}

  logRequest(method: string, url: string): void {
    // Log at debug level - will appear when debug logging is enabled
    this.logger.debug({ method, url }, `HTTP ${method} ${url}`)
  }

  logResponse(method: string, url: string, statusCode: number): void {
    // Log at debug level - will appear when debug logging is enabled
    this.logger.debug({ method, url, statusCode }, `HTTP ${method} ${url} → ${statusCode}`)
  }
}
