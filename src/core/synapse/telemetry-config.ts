import type { TelemetryConfig } from '@filoz/synapse-sdk'

import { name as packageName, version as packageVersion } from '../utils/version.js'

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
      filecoinPinVersion: `${packageName}@v${packageVersion}`,
    },
  }
}
