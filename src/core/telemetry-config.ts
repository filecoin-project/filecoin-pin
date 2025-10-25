import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG_DIR = join(homedir(), '.filecoin-pin')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

interface TelemetryConfig {
  telemetry?: {
    disabled?: boolean
  }
}

/**
 * Read telemetry config from file
 */
export function readTelemetryConfig(): TelemetryConfig {
  try {
    if (!existsSync(CONFIG_FILE)) {
      return {}
    }
    const content = readFileSync(CONFIG_FILE, 'utf-8')
    return JSON.parse(content)
  } catch (error) {
    // If config is corrupted or unreadable, return empty config
    return {}
  }
}

/**
 * Write telemetry config to file
 */
export function writeTelemetryConfig(config: TelemetryConfig): void {
  try {
    // Create config directory if it doesn't exist
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true })
    }

    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8')
  } catch (error) {
    // Fail silently - telemetry config is not critical
  }
}

/**
 * Check if telemetry is disabled in config
 */
export function isTelemetryDisabledInConfig(): boolean {
  const config = readTelemetryConfig()
  return config.telemetry?.disabled === true
}

/**
 * Disable telemetry in config (persists to disk)
 */
export function disableTelemetryInConfig(): void {
  const config = readTelemetryConfig()
  config.telemetry = { disabled: true }
  writeTelemetryConfig(config)
}
