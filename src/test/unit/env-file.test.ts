import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyEnvFileArg, findEnvFileArg, loadEnvFile, parseEnvFile } from '../../utils/env-file.js'

describe('parseEnvFile', () => {
  it('parses KEY=VALUE lines', () => {
    expect(parseEnvFile('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('ignores blank lines and comments', () => {
    expect(parseEnvFile('# a comment\n\nFOO=bar\n  \n# another\nBAZ=qux\n')).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('strips a single pair of surrounding single or double quotes', () => {
    expect(parseEnvFile(`FOO="bar"\nBAZ='qux'\nQUUX=no-quotes`)).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
      QUUX: 'no-quotes',
    })
  })

  it('does not strip mismatched or partial quotes', () => {
    expect(parseEnvFile(`FOO="bar'\nBAZ='qux`)).toEqual({ FOO: '"bar\'', BAZ: "'qux" })
  })

  it('trims whitespace around keys and values', () => {
    expect(parseEnvFile('  FOO  =  bar  ')).toEqual({ FOO: 'bar' })
  })

  it('skips lines without an =', () => {
    expect(parseEnvFile('not a valid line\nFOO=bar')).toEqual({ FOO: 'bar' })
  })
})

describe('loadEnvFile', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'env-file-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('sets process.env-style variables from the file', () => {
    const path = join(dir, '.env')
    writeFileSync(path, 'SESSION_KEY=0xabc\nWALLET_ADDRESS=0xdef\n')

    const env: NodeJS.ProcessEnv = {}
    loadEnvFile(path, env)

    expect(env.SESSION_KEY).toBe('0xabc')
    expect(env.WALLET_ADDRESS).toBe('0xdef')
  })

  it('does not override a variable already set in the environment', () => {
    const path = join(dir, '.env')
    writeFileSync(path, 'SESSION_KEY=from-file\n')

    const env: NodeJS.ProcessEnv = { SESSION_KEY: 'from-real-env' }
    loadEnvFile(path, env)

    expect(env.SESSION_KEY).toBe('from-real-env')
  })

  it('throws a clear error naming the path when the file is missing', () => {
    const path = join(dir, 'does-not-exist.env')

    expect(() => loadEnvFile(path, {})).toThrow(path)
  })
})

describe('findEnvFileArg', () => {
  it('finds a space-separated --env-file <path> anywhere in argv', () => {
    expect(findEnvFileArg(['node', 'cli.js', 'add', '--env-file', '/tmp/x.env', 'file.txt'])).toBe('/tmp/x.env')
  })

  it('finds an --env-file=<path> form', () => {
    expect(findEnvFileArg(['node', 'cli.js', 'add', '--env-file=/tmp/x.env'])).toBe('/tmp/x.env')
  })

  it('returns undefined when not present', () => {
    expect(findEnvFileArg(['node', 'cli.js', 'add', 'file.txt'])).toBeUndefined()
  })
})

describe('applyEnvFileArg', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'env-file-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('is a no-op when --env-file is absent', () => {
    const env: NodeJS.ProcessEnv = {}
    applyEnvFileArg(['node', 'cli.js', 'add', 'file.txt'], env)
    expect(env).toEqual({})
  })

  it('loads the file named by --env-file before other resolution', () => {
    const path = join(dir, '.env')
    writeFileSync(path, 'SESSION_KEY=0xabc\n')

    const env: NodeJS.ProcessEnv = {}
    applyEnvFileArg(['node', 'cli.js', 'add', '--env-file', path], env)

    expect(env.SESSION_KEY).toBe('0xabc')
  })
})

describe('parseEnvFile shell-sourceable input', () => {
  it('strips a leading export prefix', () => {
    expect(parseEnvFile('export SESSION_KEY=0xabc')).toEqual({ SESSION_KEY: '0xabc' })
  })

  it('skips keys containing whitespace', () => {
    expect(parseEnvFile('BAD KEY=1\nGOOD=2')).toEqual({ GOOD: '2' })
  })
})

describe('loadEnvFile empty file', () => {
  it('fails naming the path and the expected format', () => {
    const file = join(tmpdir(), `envfile-empty-${process.pid}.env`)
    writeFileSync(file, '# only comments\n\n')
    try {
      expect(() => loadEnvFile(file, {})).toThrow(/no usable entries.*Expected dotenv-style/s)
    } finally {
      rmSync(file, { force: true })
    }
  })
})
