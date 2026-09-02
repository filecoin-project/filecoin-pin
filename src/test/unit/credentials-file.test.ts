import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyCredentialsFileArg, findCredentialsFileArg, loadCredentialsFile } from '../../utils/credentials-file.js'

describe('loadCredentialsFile', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'credentials-file-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('sets process.env-style variables from the file', () => {
    const path = join(dir, '.env')
    writeFileSync(path, 'SESSION_KEY=0xabc\nWALLET_ADDRESS=0xdef\n')

    const env: NodeJS.ProcessEnv = {}
    loadCredentialsFile(path, env)

    expect(env.SESSION_KEY).toBe('0xabc')
    expect(env.WALLET_ADDRESS).toBe('0xdef')
  })

  it('does not override a variable already set in the environment', () => {
    const path = join(dir, '.env')
    writeFileSync(path, 'SESSION_KEY=from-file\n')

    const env: NodeJS.ProcessEnv = { SESSION_KEY: 'from-real-env' }
    loadCredentialsFile(path, env)

    expect(env.SESSION_KEY).toBe('from-real-env')
  })

  it('throws a clear error naming the path when the file is missing', () => {
    const path = join(dir, 'does-not-exist.env')

    expect(() => loadCredentialsFile(path, {})).toThrow(path)
  })
})

describe('findCredentialsFileArg', () => {
  it('finds a space-separated --credentials-file <path> anywhere in argv', () => {
    expect(findCredentialsFileArg(['node', 'cli.js', 'add', '--credentials-file', '/tmp/x.env', 'file.txt'])).toBe(
      '/tmp/x.env'
    )
  })

  it('finds an --credentials-file=<path> form', () => {
    expect(findCredentialsFileArg(['node', 'cli.js', 'add', '--credentials-file=/tmp/x.env'])).toBe('/tmp/x.env')
  })

  it('returns undefined when not present', () => {
    expect(findCredentialsFileArg(['node', 'cli.js', 'add', 'file.txt'])).toBeUndefined()
  })
})

describe('applyCredentialsFileArg', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'credentials-file-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('is a no-op when --credentials-file is absent', () => {
    const env: NodeJS.ProcessEnv = {}
    applyCredentialsFileArg(['node', 'cli.js', 'add', 'file.txt'], env)
    expect(env).toEqual({})
  })

  it('loads the file named by --credentials-file before other resolution', () => {
    const path = join(dir, '.env')
    writeFileSync(path, 'SESSION_KEY=0xabc\n')

    const env: NodeJS.ProcessEnv = {}
    applyCredentialsFileArg(['node', 'cli.js', 'add', '--credentials-file', path], env)

    expect(env.SESSION_KEY).toBe('0xabc')
  })
})

describe('loadCredentialsFile empty file', () => {
  it('fails naming the path and the expected format', () => {
    const file = join(tmpdir(), `envfile-empty-${process.pid}.env`)
    writeFileSync(file, '# only comments\n\n')
    try {
      expect(() => loadCredentialsFile(file, {})).toThrow(/no usable entries.*Expected dotenv-style/s)
    } finally {
      rmSync(file, { force: true })
    }
  })
})
