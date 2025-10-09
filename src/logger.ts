import { type Logger, pino } from 'pino'
import type { SynapseSetupConfig } from './core/synapse/index.js'

export function createLogger(config: Pick<SynapseSetupConfig, 'logLevel'>): Logger {
  return pino({
    level: config.logLevel ?? 'info',
  })
}
