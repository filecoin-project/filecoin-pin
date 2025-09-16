import { describe, expect, it } from 'vitest'
import { createConfig } from '../../config.js'
import { createLogger } from '../../logger.js'

describe('Logger', () => {
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
