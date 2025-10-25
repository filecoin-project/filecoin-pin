import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isTelemetryDisabledInConfig, disableTelemetryInConfig } from './telemetry-config.js'

const TELEMETRY_ENDPOINT = 'https://eomwm816g3v5sar.m.pipedream.net'
const CONFIG_DIR = join(homedir(), '.filecoin-pin')
const TELEMETRY_ID_FILE = join(CONFIG_DIR, '.telemetry-id')
const REQUEST_TIMEOUT = 5000 // 5 seconds

interface TelemetryPayload {
  event: string
  anonymousId: string
  version: string
  platform: string
  timestamp: string
  testMode?: string
}

interface TrackingOptions {
  isPrivate: boolean
  isTest: boolean
}

/**
 * Check if telemetry is disabled via environment variable
 */
function isTelemetryDisabled(): boolean {
  return process.env.FILECOIN_PIN_TELEMETRY_DISABLED === '1'
}

/**
 * Get or create anonymous telemetry ID
 */
function getOrCreateTelemetryId(): { id: string; isFirstRun: boolean } {
  try {
    // Create config directory if it doesn't exist
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true })
    }

    // Check if telemetry ID file exists
    if (existsSync(TELEMETRY_ID_FILE)) {
      const id = readFileSync(TELEMETRY_ID_FILE, 'utf-8').trim()
      return { id, isFirstRun: false }
    }

    // First run - generate new UUID
    const id = randomUUID()
    writeFileSync(TELEMETRY_ID_FILE, id, 'utf-8')
    return { id, isFirstRun: true }
  } catch (error) {
    // Fail silently if we can't access filesystem
    if (process.env.DEBUG_TELEMETRY) {
      console.error('Telemetry ID error:', error)
    }
    return { id: 'unknown', isFirstRun: false }
  }
}

/**
 * Send telemetry event to endpoint
 */
async function sendTelemetryEvent(payload: TelemetryPayload): Promise<void> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)

    if (process.env.DEBUG_TELEMETRY) {
      console.log('Sending payload:', JSON.stringify(payload, null, 2))
    }

    const response = await fetch(TELEMETRY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (process.env.DEBUG_TELEMETRY) {
      console.log('Telemetry sent successfully:', response.status)
    }
  } catch (error) {
    // Fail silently - telemetry should never block CLI functionality
    if (process.env.DEBUG_TELEMETRY) {
      console.error('Telemetry error:', error instanceof Error ? error.message : error)
    }
  }
}

/**
 * Track CLI first run event
 * This function is non-blocking and will not throw errors
 */
export function trackFirstRun(version: string, options?: TrackingOptions): void {
  // Don't await - fire and forget
  void (async () => {
    try {
      // If --private flag is used, save to config and exit
      if (options?.isPrivate) {
        disableTelemetryInConfig()
        if (process.env.DEBUG_TELEMETRY) {
          console.log('Telemetry disabled via --private flag (saved to config)')
        }
        return
      }

      // Check opt-out via config file, then environment variable
      if (isTelemetryDisabledInConfig() || isTelemetryDisabled()) {
        return
      }

      // Get or create telemetry ID
      const { id, isFirstRun } = getOrCreateTelemetryId()

      // Only send event on first run
      if (!isFirstRun) {
        return
      }

      // Prepare payload
      const payload: TelemetryPayload = {
        event: 'cli_first_run',
        anonymousId: id,
        version,
        platform: process.platform,
        timestamp: new Date().toISOString(),
      }

      // Add testMode flag if --test is used
      if (options?.isTest) {
        payload.testMode = 'test'
      }

      // Send telemetry
      await sendTelemetryEvent(payload)
    } catch (error) {
      // Fail silently
      if (process.env.DEBUG_TELEMETRY) {
        console.error('Telemetry error:', error instanceof Error ? error.message : error)
      }
    }
  })()
}
