import { Environment, TelemetryConfig } from '@filoz/synapse-sdk';
import packageJson from '../../../package.json' with { type: 'json' };

export const getTelemetryConfig = (environment: Environment = 'development'): TelemetryConfig => ({
  appName: `${packageJson.name}@v${packageJson.version}`,
  enabled: true,
  environment,
})
