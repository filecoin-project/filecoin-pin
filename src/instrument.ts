import Sentry from '@sentry/node'
import { name as packageName, version as packageVersion } from './core/utils/version.js'

// Ensure to call this before requiring any other modules!
Sentry.init({
  dsn: 'https://9TMHhmfsi93WgHaMSXoQ2qhQ@s1685337.us-east-9.betterstackdata.com/1685337',
  // Setting this option to false will prevent the SDK from sending default PII data to Sentry.
  // For example, automatic IP address collection on events
  sendDefaultPii: false,
  // Enable tracing/performance monitoring
  tracesSampleRate: 1.0, // Capture 100% of transactions for development (adjust in production)
  enabled: process.env.FILECOIN_PIN_TELEMETRY_DISABLED !== 'true',
})

Sentry.setTags({
  filecoinPinVersion: `${packageName}@v${packageVersion}`,
})
