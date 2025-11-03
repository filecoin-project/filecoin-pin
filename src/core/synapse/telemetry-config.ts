import type { TelemetryConfig } from '@filoz/synapse-sdk'
// biome-ignore lint/correctness/useImportExtensions: package.json is bundled for browser and node
import packageJson from '../../../package.json' with { type: 'json' }

export const getTelemetryConfig = (config?: TelemetryConfig | undefined): TelemetryConfig => {
  return {
    ...config,
    sentryInitOptions: {
      enabled: true,
      // allow config.enabled to override default
      ...config?.sentryInitOptions,
    },
    sentrySetTags: {
      ...config?.sentrySetTags,
      filecoinPinVersion: `${packageJson.name}@v${packageJson.version}`,
    },
  }
}
