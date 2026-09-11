import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addSigningAuthOptions, credentialsFileOption } from '../../utils/cli-options.js'
import { applyCredentialsFile, readCredentialsFile } from '../../utils/credentials-file.js'

describe('readCredentialsFile', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'credentials-file-test-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads the credential variables from the file', () => {
    const path = join(dir, '.env')
    writeFileSync(path, 'SESSION_KEY=0xabc\nWALLET_ADDRESS=0xdef\n')

    expect(readCredentialsFile(path)).toEqual({ SESSION_KEY: '0xabc', WALLET_ADDRESS: '0xdef' })
  })

  it('ignores anything that is not a credential, so a file cannot redirect the console or the RPC', () => {
    const path = join(dir, '.env')
    writeFileSync(path, 'SESSION_KEY=0xabc\nCONSOLE_URL=https://evil.example\nRPC_URL=https://evil.example/rpc\n')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(readCredentialsFile(path)).toEqual({ SESSION_KEY: '0xabc' })
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('ignored CONSOLE_URL, RPC_URL'))
  })

  it.each(['PRIVATE_KEY', 'VIEW_ADDRESS', 'NETWORK'])('reads %s from the file', (name) => {
    const path = join(dir, '.env')
    writeFileSync(path, `${name}=x\n`)

    expect(readCredentialsFile(path)).toEqual({ [name]: 'x' })
  })

  it('fails on a file that holds nothing but ignored keys, instead of loading nothing silently', () => {
    const path = join(dir, '.env')
    writeFileSync(path, 'CONSOLE_URL=https://evil.example\n')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(() => readCredentialsFile(path)).toThrow(/no usable entries/)
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('ignored CONSOLE_URL'))
  })

  it('throws a clear error naming the path when the file is missing', () => {
    const path = join(dir, 'does-not-exist.env')

    expect(() => readCredentialsFile(path)).toThrow(`could not read "${path}": file not found`)
  })

  it('fails on a file with no entries, naming the path and the expected format', () => {
    const path = join(dir, 'empty.env')
    writeFileSync(path, '# only comments\n\n')

    expect(() => readCredentialsFile(path)).toThrow(/no usable entries.*Expected dotenv-style/s)
  })
})

describe('applyCredentialsFile', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'credentials-file-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** A root program declaring `--credentials-file`, with a signing subcommand, parsed and hooked like cli.ts. */
  async function parse(args: string[], env: NodeJS.ProcessEnv): Promise<Command> {
    const program = new Command().exitOverride().addOption(credentialsFileOption())
    let action: Command | undefined
    const add = addSigningAuthOptions(new Command('add').exitOverride()).action(function (this: Command) {
      action = this
    })
    program.addCommand(add)
    program.hook('preAction', (_thisCommand, actionCommand) => applyCredentialsFile(actionCommand, env))
    await program.parseAsync(args, { from: 'user' })
    if (action === undefined) throw new Error('action did not run')
    return action
  }

  it('is a no-op when --credentials-file is absent', async () => {
    const env: NodeJS.ProcessEnv = {}
    const command = await parse(['add'], env)
    expect(env).toEqual({})
    expect(command.opts()).toEqual({})
  })

  it.each([
    ['before the subcommand', (path: string) => ['--credentials-file', path, 'add']],
    ['after the subcommand', (path: string) => ['add', '--credentials-file', path]],
    ['with an equals sign', (path: string) => ['add', `--credentials-file=${path}`]],
  ])('supplies the file %s, recorded as the file source', async (_label, argv) => {
    const path = join(dir, '.env')
    writeFileSync(path, 'SESSION_KEY=0xabc\n')

    const env: NodeJS.ProcessEnv = {}
    const command = await parse(argv(path), env)

    expect(env.SESSION_KEY).toBe('0xabc')
    expect(command.opts().sessionKey).toBe('0xabc')
    expect(command.getOptionValueSource('sessionKey')).toBe('file')
  })

  it('does not override a variable already set in the environment', async () => {
    const path = join(dir, '.env')
    writeFileSync(path, 'SESSION_KEY=from-file\n')

    const env: NodeJS.ProcessEnv = { SESSION_KEY: 'from-real-env' }
    await parse(['add', '--credentials-file', path], env)

    expect(env.SESSION_KEY).toBe('from-real-env')
  })

  it('a flag still beats the file', async () => {
    const path = join(dir, '.env')
    writeFileSync(path, 'SESSION_KEY=from-file\n')

    const env: NodeJS.ProcessEnv = {}
    const command = await parse(['add', '--credentials-file', path, '--session-key', 'from-flag'], env)

    expect(command.opts().sessionKey).toBe('from-flag')
    expect(command.getOptionValueSource('sessionKey')).toBe('cli')
    expect(env.SESSION_KEY).toBeUndefined()
  })

  it('surfaces a missing file through the parse, naming the path', async () => {
    const path = join(dir, 'does-not-exist.env')
    await expect(parse(['add', '--credentials-file', path], {})).rejects.toThrow(`could not read "${path}"`)
  })
})
