import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const TSX = join(ROOT, 'node_modules/tsx/dist/cli.mjs')
const HELPER = join(ROOT, 'src/test/helpers/emit-large-envelope.ts')
const PIPE_BUFFER = 64 * 1024

describe('emit slow-reader subprocess', () => {
  it('delivers a document larger than the pipe buffer intact', { timeout: 30_000 }, async () => {
    const child = spawn(process.execPath, [TSX, HELPER], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.setEncoding('utf8')
    let received = ''
    child.stdout.on('data', (chunk: string) => {
      received += chunk
    })
    child.stdout.pause()

    const pump = setInterval(() => {
      child.stdout.resume()
      setTimeout(() => child.stdout.pause(), 5)
    }, 15)

    const [exitCode] = (await once(child, 'close')) as [number | null]
    clearInterval(pump)
    child.stdout.resume()
    if (!child.stdout.readableEnded) {
      await once(child.stdout, 'end')
    }

    expect(exitCode).toBe(0)
    expect(received.length).toBeGreaterThan(PIPE_BUFFER)
    const parsed = JSON.parse(received) as { code: string; data: { blob: string } }
    expect(parsed.code).toBe('OK')
    expect(parsed.data.blob).toBe('x'.repeat(256 * 1024))
  })
})
