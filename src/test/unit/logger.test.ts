import { describe, expect, it } from 'vitest'
import { createLogger } from '../../logger.js'

describe('Logger', () => {
  it('should create a logger with the specified log level', () => {
    const logger = createLogger({ logLevel: 'info' })

    expect(logger).toBeDefined()
    expect(logger.level).toBe('info')
  })

  it('should create a logger with debug level', () => {
    const logger = createLogger({ logLevel: 'debug' })

    expect(logger.level).toBe('debug')
  })
})
