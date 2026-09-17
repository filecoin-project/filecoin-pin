import { once } from 'node:events'

export const ENVELOPE_SCHEMA_VERSION = 1

export const COMMAND_CODES = [
  'OK',
  'INVALID_ARGUMENT',
  'AUTH_REQUIRED',
  'AUTHORIZATION_INCOMPLETE',
  'INSUFFICIENT_FUNDS',
  'INTERACTION_REQUIRED',
  'PARTIAL_FAILURE',
  'CANCELLED',
  'RPC_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const

export type CommandCode = (typeof COMMAND_CODES)[number]

export type CommandAction =
  | {
      type: 'open_url'
      actor: 'user' | 'agent'
      url: string
      message: string
    }
  | {
      type: 'run_command'
      actor: 'user' | 'agent'
      argv: string[]
      message: string
    }

export interface CommandError {
  message: string
  details?: unknown
}

export interface CommandEnvelope<T = unknown> {
  schemaVersion: typeof ENVELOPE_SCHEMA_VERSION
  code: CommandCode
  data: T | null
  error: CommandError | null
  actions: CommandAction[]
}

const EXIT_CODE_BY_CODE: Record<CommandCode, 0 | 1 | 2> = {
  OK: 0,
  AUTHORIZATION_INCOMPLETE: 2,
  CANCELLED: 2,
  INVALID_ARGUMENT: 1,
  AUTH_REQUIRED: 1,
  INSUFFICIENT_FUNDS: 1,
  INTERACTION_REQUIRED: 1,
  PARTIAL_FAILURE: 1,
  RPC_UNAVAILABLE: 1,
  INTERNAL_ERROR: 1,
}

let jsonMode = false

export function applyJsonMode(json: boolean | undefined): void {
  jsonMode = json === true
}

export function isJsonMode(): boolean {
  return jsonMode
}

export function exitCodeFor(code: CommandCode): 0 | 1 | 2 {
  return EXIT_CODE_BY_CODE[code]
}

export async function emit(envelope: CommandEnvelope, out: NodeJS.WritableStream = process.stdout): Promise<void> {
  const payload = `${JSON.stringify(envelope)}\n`
  const flushed = out.write(payload)
  if (!flushed) {
    await once(out, 'drain')
  }
  process.exitCode = exitCodeFor(envelope.code)
}
