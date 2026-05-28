/**
 * Host-side helper that reads environment variables into a partial
 * {@link TelemetryConfiguration}, so the caller can compose it with their own
 * fields (e.g. `configureTelemetry({ ...readTelemetryConfigFromEnv(), affordance: 'CLI' })`).
 *
 * The telemetry library never reads `process.env` itself; this file lives
 * outside `src/core/` because env-var handling is a host concern, not a
 * library responsibility. Used by the CLI and the GitHub Action; embedding
 * apps can either reuse this helper or apply their own configuration policy.
 */

import type { TelemetryConfiguration } from './core/telemetry/index.js'

export function readTelemetryConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<TelemetryConfiguration> {
  const config: Partial<TelemetryConfiguration> = {
    disabled:
      env.FILECOIN_PIN_TELEMETRY_DISABLED === 'true' ||
      env.DO_NOT_TRACK === '1' ||
      env.DO_NOT_TRACK?.toLowerCase() === 'true',
  }
  if (env.FILECOIN_PIN_METRICS_ENDPOINT != null) {
    config.endpoint = env.FILECOIN_PIN_METRICS_ENDPOINT
  }
  if (env.FILECOIN_PIN_METRICS_TOKEN != null) {
    config.token = env.FILECOIN_PIN_METRICS_TOKEN
  }
  return config
}
