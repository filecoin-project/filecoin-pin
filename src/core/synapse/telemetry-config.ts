import type { TelemetryConfig } from '@filoz/synapse-sdk'
// biome-ignore lint/correctness/useImportExtensions: package.json is bundled for browser and node
import packageJson from '../../../package.json' with { type: 'json' }

export const getTelemetryConfig = (config?: TelemetryConfig | undefined): TelemetryConfig => {
  let appName = `${packageJson.name}@v${packageJson.version}`
  if (config?.appName != null) {
    appName = `${appName}-${config.appName}`
  }

  return {
    enabled: true, // allow config.enabled to override default
    ...config,
    appName, // use constructed appName, always.
    environment: config?.environment || 'development',
  }
}
