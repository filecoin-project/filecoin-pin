import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const configureTelemetry = vi.hoisted(() => vi.fn())

vi.mock('../../core/telemetry/index.js', () => ({
  configureTelemetry,
}))

const { configureTelemetryFromEnv } = await import('../../configure-telemetry-from-env.js')

describe('configureTelemetryFromEnv', () => {
  beforeEach(() => {
    configureTelemetry.mockReset()
  })

  afterEach(() => {
    configureTelemetry.mockReset()
  })

  it('treats an empty env as enabled with default endpoint and token', () => {
    configureTelemetryFromEnv({})
    expect(configureTelemetry).toHaveBeenCalledWith({ disabled: false })
  })

  it('disables telemetry when FILECOIN_PIN_TELEMETRY_DISABLED=true', () => {
    configureTelemetryFromEnv({ FILECOIN_PIN_TELEMETRY_DISABLED: 'true' })
    expect(configureTelemetry).toHaveBeenCalledWith({ disabled: true })
  })

  it('disables telemetry when DO_NOT_TRACK=1', () => {
    configureTelemetryFromEnv({ DO_NOT_TRACK: '1' })
    expect(configureTelemetry).toHaveBeenCalledWith({ disabled: true })
  })

  it('disables telemetry when DO_NOT_TRACK=true (case-insensitive)', () => {
    configureTelemetryFromEnv({ DO_NOT_TRACK: 'True' })
    expect(configureTelemetry).toHaveBeenCalledWith({ disabled: true })
  })

  it('forwards endpoint and token overrides when present', () => {
    configureTelemetryFromEnv({
      FILECOIN_PIN_METRICS_ENDPOINT: 'https://example.test/metrics',
      FILECOIN_PIN_METRICS_TOKEN: 'override-token',
    })
    expect(configureTelemetry).toHaveBeenCalledWith({
      disabled: false,
      endpoint: 'https://example.test/metrics',
      token: 'override-token',
    })
  })

  it('omits endpoint/token keys entirely when the env var is unset', () => {
    configureTelemetryFromEnv({ FILECOIN_PIN_METRICS_ENDPOINT: 'https://only-endpoint.test' })
    expect(configureTelemetry).toHaveBeenCalledWith({
      disabled: false,
      endpoint: 'https://only-endpoint.test',
    })
  })
})
