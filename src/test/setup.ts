/**
 * Global test setup - runs before all test files
 *
 * This ensures tests have a clean environment without interference
 * from local development environment variables.
 */
import { beforeEach } from 'vitest'
import { configureTelemetry } from '../core/telemetry/index.js'

// Clear authentication-related environment variables that might interfere with tests
// Tests should explicitly set these values when needed
beforeEach(() => {
  delete process.env.WALLET_ADDRESS
  delete process.env.SESSION_KEY
  delete process.env.PRIVATE_KEY
  // No metrics from tests, and no utm tail on console links so exact-URL
  // asserts stay readable. console-url.test.ts re-enables it for its own block.
  configureTelemetry({ disabled: true, affordance: 'Library', driver: undefined })
})
