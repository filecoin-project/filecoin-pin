import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addSigningAuthOptions } from '../../utils/cli-options.js'
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

    expect(() => loadCredentialsFile(path, {})).toThrow(`could not read "${path}": file not found`)
  })

  it('fails on a file with no entries, naming the path and the expected format', () => {
    const path = join(dir, 'empty.env')
    writeFileSync(path, '# only comments\n\n')

    expect(() => loadCredentialsFile(path, {})).toThrow(/no usable entries.*Expected dotenv-style/s)
  })

  it('a flag still beats a value the file loaded into the environment', () => {
    const path = join(dir, '.env')
    writeFileSync(path, 'SESSION_KEY=from-file\n')
    const env: NodeJS.ProcessEnv = {}
    loadCredentialsFile(path, env)

    const command = addSigningAuthOptions(new Command()).exitOverride()
    const previous = process.env.SESSION_KEY
    process.env.SESSION_KEY = env.SESSION_KEY
    try {
      command.parse(['--session-key', 'from-flag'], { from: 'user' })
      expect(command.opts().sessionKey).toBe('from-flag')
      command.parse([], { from: 'user' })
      expect(command.opts().sessionKey).toBe('from-file')
    } finally {
      if (previous === undefined) delete process.env.SESSION_KEY
      else process.env.SESSION_KEY = previous
    }
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
