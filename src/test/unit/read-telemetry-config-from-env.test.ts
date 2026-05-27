import { describe, expect, it } from 'vitest'

import { readTelemetryConfigFromEnv } from '../../read-telemetry-config-from-env.js'

describe('readTelemetryConfigFromEnv', () => {
  it('treats an empty env as enabled, with no endpoint or token override', () => {
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

  it('forwards endpoint and token overrides when present', () => {
    expect(
      readTelemetryConfigFromEnv({
        FILECOIN_PIN_METRICS_ENDPOINT: 'https://example.test/metrics',
        FILECOIN_PIN_METRICS_TOKEN: 'override-token',
      })
    ).toEqual({
      disabled: false,
      endpoint: 'https://example.test/metrics',
      token: 'override-token',
    })
  })

  it('omits endpoint/token keys entirely when the env var is unset', () => {
    expect(readTelemetryConfigFromEnv({ FILECOIN_PIN_METRICS_ENDPOINT: 'https://only-endpoint.test' })).toEqual({
      disabled: false,
      endpoint: 'https://only-endpoint.test',
    })
  })
})
