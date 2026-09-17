import { Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyJsonMode,
  type CommandAction,
  type CommandCode,
  type CommandEnvelope,
  ENVELOPE_SCHEMA_VERSION,
  emit,
  exitCodeFor,
  isJsonMode,
} from '../../common/command-envelope.js'
import { isInteractive } from '../../utils/cli-helpers.js'

const CODES: CommandCode[] = [
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
]

const OPEN_URL: CommandAction = {
  type: 'open_url',
  actor: 'user',
  url: 'https://example.test/approve',
  message: 'Open the console to approve the session',
}

const RUN_COMMAND: CommandAction = {
  type: 'run_command',
  actor: 'agent',
  argv: ['filecoin-pin', 'payments', 'fund'],
  message: 'Fund the account then retry',
}

function envelopeFor(code: CommandCode): CommandEnvelope<{ id: string }> {
  const ok = code === 'OK'
  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    code,
    data: ok ? { id: 'piece-1' } : { id: 'partial' },
    error: ok ? null : { message: `${code} failed`, details: { code } },
    actions: ok ? [] : [OPEN_URL, RUN_COMMAND],
  }
}

describe('CommandEnvelope', () => {
  it.each(CODES)('round-trips %s through JSON', (code) => {
    const original = envelopeFor(code)
    const parsed = JSON.parse(JSON.stringify(original)) as CommandEnvelope<{ id: string }>
    expect(parsed).toEqual(original)
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.code).toBe(code)
    if (code === 'OK') {
      expect(parsed.error).toBeNull()
      expect(parsed.data).toEqual({ id: 'piece-1' })
    } else {
      expect(parsed.error?.message).toContain(code)
      expect(parsed.data).toEqual({ id: 'partial' })
      expect(parsed.actions).toHaveLength(2)
    }
  })
})

describe('exitCodeFor', () => {
  it('maps OK to 0', () => {
    expect(exitCodeFor('OK')).toBe(0)
  })

  it('maps incomplete outcomes to 2', () => {
    expect(exitCodeFor('AUTHORIZATION_INCOMPLETE')).toBe(2)
    expect(exitCodeFor('CANCELLED')).toBe(2)
  })

  it.each(
    CODES.filter((code) => code !== 'OK' && code !== 'AUTHORIZATION_INCOMPLETE' && code !== 'CANCELLED')
  )('maps %s to 1', (code) => {
    expect(exitCodeFor(code)).toBe(1)
  })
})

describe('emit', () => {
  it('writes one JSON document and sets process.exitCode', async () => {
    const chunks: Buffer[] = []
    const out = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk))
        cb()
      },
    })
    const previous = process.exitCode
    process.exitCode = 0
    try {
      await emit(envelopeFor('CANCELLED'), out)
      const body = Buffer.concat(chunks).toString('utf8')
      expect(JSON.parse(body)).toEqual(envelopeFor('CANCELLED'))
      expect(process.exitCode).toBe(2)
    } finally {
      process.exitCode = previous
    }
  })

  it('waits for drain when the destination buffers', async () => {
    const chunks: Buffer[] = []
    let drainCount = 0
    const out = new Writable({
      highWaterMark: 16,
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk))
        setTimeout(cb, 15)
      },
    })
    out.on('drain', () => {
      drainCount += 1
    })

    const previous = process.exitCode
    process.exitCode = 0
    try {
      const large: CommandEnvelope<{ blob: string }> = {
        schemaVersion: 1,
        code: 'OK',
        data: { blob: 'x'.repeat(64 * 1024) },
        error: null,
        actions: [],
      }
      await emit(large, out)
      expect(Buffer.concat(chunks).toString('utf8').length).toBeGreaterThan(64 * 1024)
      expect(drainCount).toBeGreaterThan(0)
      expect(process.exitCode).toBe(0)
    } finally {
      process.exitCode = previous
    }
  })
})

describe('applyJsonMode', () => {
  afterEach(() => {
    applyJsonMode(false)
  })

  it('is off by default', () => {
    expect(isJsonMode()).toBe(false)
  })

  it('forces isInteractive() to false when --json is set', () => {
    applyJsonMode(true)
    expect(isJsonMode()).toBe(true)
    expect(isInteractive()).toBe(false)
  })
})
