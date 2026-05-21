/**
 * CLI-side helper that maps environment variables to {@link configureTelemetry}.
 *
 * The telemetry library never reads `process.env` itself; this file lives
 * outside `src/core/` because env-var handling is a CLI concern, not a
 * library responsibility. Other Node hosts (the GitHub Action, embedding
 * apps) can either reuse this helper or apply their own configuration
 * policy.
 */

import { configureTelemetry } from './core/telemetry/index.js'

export function configureTelemetryFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  const disabled =
    env.FILECOIN_PIN_TELEMETRY_DISABLED === 'true' ||
    env.DO_NOT_TRACK === '1' ||
    env.DO_NOT_TRACK?.toLowerCase() === 'true'

  const overrides: Parameters<typeof configureTelemetry>[0] = { disabled }
  if (env.FILECOIN_PIN_OTLP_METRICS_ENDPOINT != null) {
    overrides.endpoint = env.FILECOIN_PIN_OTLP_METRICS_ENDPOINT
  }
  if (env.FILECOIN_PIN_OTLP_METRICS_TOKEN != null) {
    overrides.token = env.FILECOIN_PIN_OTLP_METRICS_TOKEN
  }
  configureTelemetry(overrides)
}
