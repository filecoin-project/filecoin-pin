import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createConfig } from '../../config.js'
import { createLogger } from '../../logger.js'

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
    const config = createConfig()
    const logger = createLogger(config)

    expect(logger).toBeDefined()
    expect(logger.level).toBe('info')
  })

  it('should create a logger with debug level', () => {
    const config = { ...createConfig(), logLevel: 'debug' }
    const logger = createLogger(config)

    expect(logger.level).toBe('debug')
  })
})
