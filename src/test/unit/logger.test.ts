import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLogger } from '../../logger.js'

function destinationFd(logger: pino.Logger): number | undefined {
  const stream = (logger as unknown as Record<symbol, { fd?: number }>)[pino.symbols.streamSym]
  return stream?.fd
}

describe('Logger', () => {
  const originalLogLevel = process.env.LOG_LEVEL

  beforeEach(() => {
    delete process.env.LOG_LEVEL
  })

  afterEach(() => {
    if (originalLogLevel == null) {
      delete process.env.LOG_LEVEL
    } else {
      process.env.LOG_LEVEL = originalLogLevel
    }
  })

  it('should create a logger with the specified log level', () => {
    const logger = createLogger({ logLevel: 'info' })

    expect(logger).toBeDefined()
    expect(logger.level).toBe('info')
  })

  it('should create a logger with debug level', () => {
    const logger = createLogger({ logLevel: 'debug' })

    expect(logger.level).toBe('debug')
  })

  it('sends diagnostics to stderr so stdout stays free of log lines', () => {
    const logger = createLogger({ logLevel: 'info' })
    expect(destinationFd(logger)).toBe(2)
  })
})
