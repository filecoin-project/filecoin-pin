/**
 * The documented credential order, end to end: flags, then env vars, then
 * --credentials-file, then the saved login. Drives a real Commander program
 * wired like src/cli.ts (root credentials-file hook, addAuthOptions on the
 * subcommand), with real files on disk, and asserts which mode parseCLIAuth
 * picks and which network survives. Every layer here must beat the one
 * below it and never conflict with the one above it.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../utils/cli-logger.js', () => ({
  isTTY: vi.fn(() => true),
  log: { warn: vi.fn(), line: vi.fn(), flush: vi.fn(), indent: vi.fn() },
}))

const state = vi.hoisted(() => ({ sessionPath: '' }))
vi.mock('../../login/session-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../login/session-file.js')>()
  return { ...actual, getSessionFilePath: () => state.sessionPath }
})

import { loginCommand, logoutCommand } from '../../commands/login.js'
import { serverCommand } from '../../commands/server.js'
import { writeSessionFile } from '../../login/session-file.js'
import { type CLIAuthOptions, parseCLIAuth } from '../../utils/cli-auth.js'
import { log } from '../../utils/cli-logger.js'
import { addAuthOptions, addAutoFundOptions, credentialsFileOption } from '../../utils/cli-options.js'
import { applySessionFileCredentials, getSessionCredentialSource } from '../../utils/credential-source.js'
import { applyCredentialsFile } from '../../utils/credentials-file.js'

const FLAG_KEY = `0x${'11'.repeat(32)}`
const ENV_KEY = `0x${'22'.repeat(32)}`
const FILE_KEY = `0x${'33'.repeat(32)}`
const SAVED_KEY = `0x${'44'.repeat(32)}` as const
const FILE_OWNER = '0x00000000000000000000000000000000000000f1'
const SAVED_OWNER = '0x00000000000000000000000000000000000000a1' as const
const AUTH_ENV = ['PRIVATE_KEY', 'SESSION_KEY', 'WALLET_ADDRESS', 'VIEW_ADDRESS', 'NETWORK', 'RPC_URL', 'CI']

let dir: string
let credentialsPath: string
const saved: Record<string, string | undefined> = {}

function setEnv(env: Record<string, string>): void {
  for (const name of AUTH_ENV) delete process.env[name]
  Object.assign(process.env, env)
}

function saveLogin(network = 'calibration'): void {
  writeSessionFile(
    {
      sessionKey: SAVED_KEY,
      sessionAddress: privateKeyToAccount(SAVED_KEY).address,
      walletAddress: SAVED_OWNER,
      network,
    },
    state.sessionPath
  )
}

function writeCredentials(lines: string[]): string {
  writeFileSync(credentialsPath, `${lines.join('\n')}\n`)
  return credentialsPath
}

/** Run `add` through a program wired like cli.ts and return what parseCLIAuth resolved. */
async function run(args: string[]): Promise<ReturnType<typeof parseCLIAuth>> {
  let resolved: ReturnType<typeof parseCLIAuth> | undefined
  const program = new Command().exitOverride().addOption(credentialsFileOption())
  program.hook('preAction', (_thisCommand, actionCommand) => applyCredentialsFile(actionCommand))
  const add = new Command('add')
    .exitOverride()
    .argument('<file>')
    .action((_file, options: CLIAuthOptions) => {
      resolved = parseCLIAuth(options)
    })
  addAutoFundOptions(addAuthOptions(add))
  program.addCommand(add)
  await program.parseAsync(['add', 'f', ...args], { from: 'user' })
  if (resolved === undefined) throw new Error('action did not run')
  return resolved
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'credential-precedence-'))
  credentialsPath = join(dir, 'credentials.env')
  state.sessionPath = join(dir, 'session.env')
  for (const name of AUTH_ENV) saved[name] = process.env[name]
  setEnv({})
})

afterEach(() => {
  for (const name of AUTH_ENV) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('credential precedence, end to end', () => {
  it('the environment beats the credentials file, even across auth modes', async () => {
    setEnv({ PRIVATE_KEY: ENV_KEY })
    const file = writeCredentials([`SESSION_KEY=${FILE_KEY}`, `WALLET_ADDRESS=${FILE_OWNER}`])
    const config = await run(['--credentials-file', file])
    expect(config).toMatchObject({ privateKey: ENV_KEY })
    expect(config).not.toHaveProperty('sessionKey')
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('ignoring --wallet-address/--session-key'))
  })

  it('the credentials file beats the saved login', async () => {
    saveLogin()
    const file = writeCredentials([`SESSION_KEY=${FILE_KEY}`, `WALLET_ADDRESS=${FILE_OWNER}`])
    const config = await run(['--credentials-file', file])
    expect(config).toMatchObject({ sessionKey: FILE_KEY, walletAddress: FILE_OWNER })
    expect(getSessionCredentialSource()).toBeUndefined()
  })

  it('the credentials file fills in only what the environment left unset', async () => {
    setEnv({ WALLET_ADDRESS: SAVED_OWNER })
    const file = writeCredentials([`SESSION_KEY=${FILE_KEY}`, `WALLET_ADDRESS=${FILE_OWNER}`])
    expect(await run(['--credentials-file', file])).toMatchObject({ sessionKey: FILE_KEY, walletAddress: SAVED_OWNER })
  })

  it('the saved login is used when nothing else supplies a credential', async () => {
    saveLogin()
    const config = await run([])
    expect(config).toMatchObject({ sessionKey: SAVED_KEY, walletAddress: SAVED_OWNER })
    expect(getSessionCredentialSource()).toBe(state.sessionPath)
  })

  it('a flag beats the saved login', async () => {
    saveLogin()
    expect(await run(['--private-key', FLAG_KEY])).toMatchObject({ privateKey: FLAG_KEY })
    expect(getSessionCredentialSource()).toBeUndefined()
  })

  it('a file value still trips the conflicts Commander checked before the hook ran', async () => {
    const file = writeCredentials([`VIEW_ADDRESS=${FILE_OWNER}`])
    await expect(run(['--credentials-file', file, '--auto-fund'])).rejects.toThrow(
      "option '--auto-fund' cannot be used with VIEW_ADDRESS from the credentials file"
    )
  })

  it('VIEW_ADDRESS in the environment forces read-only and skips the saved login', async () => {
    saveLogin()
    setEnv({ VIEW_ADDRESS: FILE_OWNER })
    expect(await run([])).toMatchObject({ readOnly: true, walletAddress: FILE_OWNER })
    expect(log.line).toHaveBeenCalledWith(expect.stringContaining('Saved login ignored because VIEW_ADDRESS is set'))
  })
})

describe('network precedence with a saved login', () => {
  it("applies the login's network when nothing chose one", async () => {
    saveLogin('calibration')
    const config = await run([])
    expect(config.chain?.id).toBe(314159)
    expect(process.env.NETWORK).toBe('calibration')
  })

  it('RPC_URL in the environment wins without a conflict', async () => {
    saveLogin('calibration')
    setEnv({ RPC_URL: 'http://rpc.example' })
    const config = await run([])
    expect(config).toMatchObject({ sessionKey: SAVED_KEY, rpcUrl: 'http://rpc.example' })
    expect(config.chain).toBeUndefined()
    expect(process.env.NETWORK).toBeUndefined()
  })

  it('--rpc-url wins without a conflict', async () => {
    saveLogin('calibration')
    const config = await run(['--rpc-url', 'http://rpc.example'])
    expect(config).toMatchObject({ rpcUrl: 'http://rpc.example' })
    expect(process.env.NETWORK).toBeUndefined()
  })

  it('NETWORK in the environment wins over the saved network', async () => {
    saveLogin('calibration')
    setEnv({ NETWORK: 'mainnet' })
    expect((await run([])).chain?.id).toBe(314)
  })

  it('RPC_URL in the environment wins over NETWORK in the credentials file', async () => {
    setEnv({ RPC_URL: 'http://rpc.example' })
    const file = writeCredentials([`PRIVATE_KEY=${FILE_KEY}`, 'NETWORK=calibration'])
    const config = await run(['--credentials-file', file])
    expect(config).toMatchObject({ privateKey: FILE_KEY, rpcUrl: 'http://rpc.example' })
    expect(process.env.NETWORK).toBeUndefined()
  })
})

describe('session loading is structural', () => {
  it.each([
    ['login', loginCommand],
    ['logout', logoutCommand],
    ['server', serverCommand],
  ])('never loads the saved login for the real %s command', async (_name, command) => {
    saveLogin()
    // The real action would open a browser or start the daemon; swap it for a
    // no-op so only the option wiring and hooks run.
    command.action(() => undefined).exitOverride()
    const program = new Command().exitOverride().addCommand(command)
    await program.parseAsync([command.name()], { from: 'user' })
    expect(command.getOptionValue('sessionKey')).toBeUndefined()
    expect(process.env.SESSION_KEY).toBeUndefined()
    expect(getSessionCredentialSource()).toBeUndefined()
  })

  it('can be invoked directly for a command that declares the options', () => {
    saveLogin()
    const command = addAuthOptions(new Command('add').exitOverride())
    command.parse([], { from: 'user' })
    expect(applySessionFileCredentials(command)).toBe(state.sessionPath)
    expect(command.getOptionValueSource('sessionKey')).toBe('session')
  })
})
