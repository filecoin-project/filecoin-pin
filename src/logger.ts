import { type Logger, pino } from 'pino'

export function createLogger(config: { logLevel?: string | undefined }): Logger {
  return pino({
    level: config.logLevel ?? 'error',
  })
}
