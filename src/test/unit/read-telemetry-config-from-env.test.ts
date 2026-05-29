import { describe, expect, it } from 'vitest'

import { readTelemetryConfigFromEnv } from '../../read-telemetry-config-from-env.js'

describe('readTelemetryConfigFromEnv', () => {
  it('treats an empty env as enabled', () => {
    expect(readTelemetryConfigFromEnv({})).toEqual({ disabled: false })
  })

  it('disables telemetry when FILECOIN_PIN_TELEMETRY_DISABLED=true', () => {
    expect(readTelemetryConfigFromEnv({ FILECOIN_PIN_TELEMETRY_DISABLED: 'true' })).toEqual({ disabled: true })
  })

  it('disables telemetry when DO_NOT_TRACK=1', () => {
    expect(readTelemetryConfigFromEnv({ DO_NOT_TRACK: '1' })).toEqual({ disabled: true })
  })

  it('disables telemetry when DO_NOT_TRACK=true (case-insensitive)', () => {
    expect(readTelemetryConfigFromEnv({ DO_NOT_TRACK: 'True' })).toEqual({ disabled: true })
  })
})
