/**
 * Global test setup - runs before all test files
 *
 * This ensures tests have a clean environment without interference
 * from local development environment variables.
 */
import { beforeEach, vi } from 'vitest'
import { configureTelemetry } from '../core/telemetry/index.js'

// Never the developer's real data directory: `add --encrypt` appends to the upload record there,
// and login reads and writes session.env. A test that needs its own directory mocks this again.
vi.mock('../config.js', async (importOriginal) => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dataDir = mkdtempSync(join(tmpdir(), 'filecoin-pin-test-data-'))
  return { ...(await importOriginal<typeof import('../config.js')>()), getDataDirectory: () => dataDir }
})

// Clear authentication-related environment variables that might interfere with tests
// Tests should explicitly set these values when needed
beforeEach(() => {
  delete process.env.WALLET_ADDRESS
  delete process.env.SESSION_KEY
  delete process.env.PRIVATE_KEY
  configureTelemetry({ disabled: true, affordance: 'Library', driver: undefined })
})
