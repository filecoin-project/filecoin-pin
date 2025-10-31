import type { TelemetryConfig } from '@filoz/synapse-sdk'
// biome-ignore lint/correctness/useImportExtensions: package.json is bundled for browser and node
import packageJson from '../../../package.json' with { type: 'json' }

export const getTelemetryConfig = (config?: TelemetryConfig | undefined): TelemetryConfig => {
  let appName = `${packageJson.name}@v${packageJson.version}`
  if (config?.sentrySetTags?.appName != null) {
    appName = `${appName}-${String(config.sentrySetTags.appName)}`
  }

  return {
    ...config,
    sentryInitOptions: {
      enabled: true,
      // allow config.enabled to override default
      ...config?.sentryInitOptions,
    },
    sentrySetTags: {
      ...config?.sentrySetTags,
      appName, // use constructed appName, always.
    },
  }
}
