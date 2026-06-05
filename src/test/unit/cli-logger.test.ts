import { describe, expect, it } from 'vitest'
import { applyVerboseLogLevel } from '../../utils/cli-logger.js'

describe('applyVerboseLogLevel', () => {
  it('sets LOG_LEVEL=debug when verbose is true and LOG_LEVEL is unset', () => {
    const env: NodeJS.ProcessEnv = {}
    applyVerboseLogLevel(true, env)
    expect(env.LOG_LEVEL).toBe('debug')
  })

  it('does not change LOG_LEVEL when verbose is false', () => {
    const env: NodeJS.ProcessEnv = {}
    applyVerboseLogLevel(false, env)
    expect(env.LOG_LEVEL).toBeUndefined()
  })

  it('does not change LOG_LEVEL when verbose is undefined', () => {
    const env: NodeJS.ProcessEnv = {}
    applyVerboseLogLevel(undefined, env)
    expect(env.LOG_LEVEL).toBeUndefined()
  })

  it('treats empty LOG_LEVEL as unset', () => {
    const env: NodeJS.ProcessEnv = { LOG_LEVEL: '' }
    applyVerboseLogLevel(true, env)
    expect(env.LOG_LEVEL).toBe('debug')
  })

  it('does not override an explicit LOG_LEVEL', () => {
    const env: NodeJS.ProcessEnv = { LOG_LEVEL: 'trace' }
    applyVerboseLogLevel(true, env)
    expect(env.LOG_LEVEL).toBe('trace')
  })
})
