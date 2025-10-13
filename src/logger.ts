import { type Logger, pino } from 'pino'

export function createLogger(config: { logLevel?: string }): Logger {
  return pino({
    level: config.logLevel ?? 'info',
  })
}
