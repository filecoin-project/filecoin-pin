import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
const temporaryFiles: string[] = []
const temporaryProcesses: ChildProcessWithoutNullStreams[] = []
const supportsPOSIXModes = process.platform !== 'win32'

function harnessEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.NETWORK
  delete env.RPC_URL
  return { ...env, ...overrides }
}

async function startRpcServer(chainId: number): Promise<string> {
  const script = [
    "import { createServer } from 'node:http'",
    `const chainId = ${chainId}`,
    'const server = createServer((request, response) => {',
    "  let body = ''",
    "  request.on('data', (chunk) => { body += chunk })",
    "  request.on('end', () => {",
    '    const payload = JSON.parse(body)',
    "    response.setHeader('content-type', 'application/json')",
    `    response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: '0x${chainId.toString(16)}' }))`,
    '  })',
    '})',
    "server.listen(0, '127.0.0.1', () => console.log(server.address().port))",
    "process.on('SIGTERM', () => server.close())",
  ].join('\n')
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script])
  temporaryProcesses.push(child)

  const port = await new Promise<number>((resolvePort, rejectPort) => {
    let stdout = ''
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const newline = stdout.indexOf('\n')
      if (newline === -1) return
      resolvePort(Number(stdout.slice(0, newline)))
    })
    child.once('error', rejectPort)
    child.once('exit', (code) => rejectPort(new Error(`RPC fixture exited with ${code}: ${stderr}`)))
  })

  return `http://127.0.0.1:${port}`
}

function runHarness(args: string[]): {
  report: Record<string, unknown>
  output: string
  outputPath: string
  status: number | null
} {
  const directory = mkdtempSync(join(tmpdir(), 'filecoin-pin-payments-smoke-test-'))
  temporaryDirectories.push(directory)
  const outputPath = join(directory, 'report.json')
  const secret = 'test-only-integrator-value'
  const result = spawnSync(
    process.execPath,
    [resolve('scripts/payments-smoke-test.mjs'), ...args, '--output', outputPath],
    {
      encoding: 'utf8',
      env: harnessEnv({ SQUID_INTEGRATOR_ID: secret, PRIVATE_KEY: '0xtest-only-key' }),
    }
  )
  return {
    report: JSON.parse(readFileSync(outputPath, 'utf8')) as Record<string, unknown>,
    output: `${result.stdout}${result.stderr}`,
    outputPath,
    status: result.status,
  }
}

afterEach(() => {
  for (const child of temporaryProcesses.splice(0)) child.kill()
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true })
  for (const file of temporaryFiles.splice(0)) rmSync(file, { force: true })
})

describe('payments smoke test', () => {
  it('requires an explicit report path outside the repository checkout', () => {
    const repositoryOutput = resolve('payments-smoke-test-report-must-not-exist.json')
    temporaryFiles.push(repositoryOutput)
    const baseArgs = [
      resolve('scripts/payments-smoke-test.mjs'),
      '--network',
      'devnet',
      '--flow',
      'setup',
      '--deposit',
      '1',
    ]
    const missingOutput = spawnSync(process.execPath, baseArgs, { encoding: 'utf8', env: harnessEnv() })
    const repositoryLocalOutput = spawnSync(process.execPath, [...baseArgs, '--output', repositoryOutput], {
      encoding: 'utf8',
      env: harnessEnv(),
    })

    expect(missingOutput.status).toBe(1)
    expect(`${missingOutput.stdout}${missingOutput.stderr}`).toContain(
      '--output is required and must point outside the repository checkout'
    )
    expect(repositoryLocalOutput.status).toBe(1)
    expect(`${repositoryLocalOutput.stdout}${repositoryLocalOutput.stderr}`).toContain(
      '--output must point outside the repository checkout'
    )
    expect(existsSync(repositoryOutput)).toBe(false)
  })

  it.runIf(supportsPOSIXModes)('rejects an outside path that resolves through a symlink into the checkout', () => {
    const directory = mkdtempSync(join(tmpdir(), 'filecoin-pin-payments-smoke-test-'))
    temporaryDirectories.push(directory)
    const repositoryLink = join(directory, 'repository-link')
    const repositoryOutput = resolve('payments-smoke-test-symlink-report-must-not-exist.json')
    temporaryFiles.push(repositoryOutput)
    symlinkSync(resolve('.'), repositoryLink, 'dir')

    const result = spawnSync(
      process.execPath,
      [
        resolve('scripts/payments-smoke-test.mjs'),
        '--network',
        'devnet',
        '--flow',
        'setup',
        '--deposit',
        '1',
        '--output',
        join(repositoryLink, 'payments-smoke-test-symlink-report-must-not-exist.json'),
      ],
      { encoding: 'utf8', env: harnessEnv() }
    )

    expect(result.status).toBe(1)
    expect(`${result.stdout}${result.stderr}`).toContain('--output must point outside the repository checkout')
    expect(existsSync(repositoryOutput)).toBe(false)
  })

  it('writes a sanitized dry-run report for a mainnet setup route without executing it', () => {
    const result = runHarness(['--network', 'mainnet', '--flow', 'setup', '--deposit', '4', '--source-cap', '5'])

    expect(result.status).toBe(0)
    expect(result.report).toMatchObject({
      execution: 'dry-run',
      flow: 'setup',
      network: 'mainnet',
      sourceCapUSDC: '5',
      sourceNativeGasCapArbitrumETH: '0.0001',
    })
    expect(JSON.stringify(result.report)).not.toContain('test-only-integrator-value')
    expect(JSON.stringify(result.report)).not.toContain('0xtest-only-key')
    if (supportsPOSIXModes) expect(statSync(result.outputPath).mode & 0o777).toBe(0o600)
    expect(result.report.safety).toMatchObject({
      normalCITestCoverageIncludesDryRunsAndUnfundedFakeChildExecuteOnly: true,
      normalCINeverRunsRealCLIOrFundedSmoke: true,
    })
    expect(result.report.command).toEqual([
      'node',
      'dist/cli.js',
      'payments',
      'setup',
      '--auto',
      '--deposit',
      '4',
      '--network',
      'mainnet',
      '--from-chain',
      'arb',
      '--from-token',
      'USDC',
      '--max-source-amount',
      '5',
    ])
  })

  it('supports fund amount and days dry runs without executing either route', () => {
    const amount = runHarness(['--network', 'calibration', '--flow', 'fund', '--amount', '2', '--mode', 'minimum'])
    const days = runHarness(['--network', 'devnet', '--flow', 'fund', '--days', '30'])

    expect(amount.status).toBe(0)
    expect(amount.report.command).toEqual([
      'node',
      'dist/cli.js',
      'payments',
      'fund',
      '--amount',
      '2',
      '--mode',
      'minimum',
      '--network',
      'calibration',
    ])
    expect(days.status).toBe(0)
    expect(days.report.command).toContain('--days')
    expect(days.report.execution).toBe('dry-run')
  })

  it('requires a target and a second acknowledgement before any mainnet execute attempt', () => {
    const missingTarget = spawnSync(
      process.execPath,
      [
        resolve('scripts/payments-smoke-test.mjs'),
        '--network',
        'mainnet',
        '--flow',
        'setup',
        '--source-cap',
        '5',
        '--execute',
      ],
      { encoding: 'utf8', env: harnessEnv() }
    )
    const directory = mkdtempSync(join(tmpdir(), 'filecoin-pin-payments-smoke-test-'))
    temporaryDirectories.push(directory)
    const output = join(directory, 'must-not-exist.json')
    const missingAcknowledgement = spawnSync(
      process.execPath,
      [
        resolve('scripts/payments-smoke-test.mjs'),
        '--network',
        'mainnet',
        '--flow',
        'fund',
        '--amount',
        '2',
        '--source-cap',
        '5',
        '--execute',
        '--output',
        output,
      ],
      { encoding: 'utf8', env: harnessEnv() }
    )

    expect(missingTarget.status).toBe(1)
    expect(`${missingTarget.stdout}${missingTarget.stderr}`).toContain('setup requires exactly one positive --deposit')
    expect(missingAcknowledgement.status).toBe(1)
    expect(`${missingAcknowledgement.stdout}${missingAcknowledgement.stderr}`).toContain('requires --ack-mainnet')
    expect(existsSync(output)).toBe(false)
  })

  it('enforces the mainnet source cap exactly in six-decimal USDC base units', () => {
    const ten = runHarness(['--network', 'mainnet', '--flow', 'fund', '--amount', '1', '--source-cap', '10'])
    const belowTen = runHarness(['--network', 'mainnet', '--flow', 'fund', '--amount', '1', '--source-cap', '9.999999'])
    const directory = mkdtempSync(join(tmpdir(), 'filecoin-pin-payments-smoke-test-'))
    temporaryDirectories.push(directory)
    for (const sourceCap of ['0', 'malformed', '10.000001', '10.0000000000000000000001']) {
      const output = join(directory, `${sourceCap}.json`)
      const result = spawnSync(
        process.execPath,
        [
          resolve('scripts/payments-smoke-test.mjs'),
          '--network',
          'mainnet',
          '--flow',
          'fund',
          '--amount',
          '1',
          '--source-cap',
          sourceCap,
          '--output',
          output,
        ],
        { encoding: 'utf8', env: harnessEnv() }
      )

      expect(result.status).toBe(1)
      expect(existsSync(output)).toBe(false)
    }
    expect(ten.status).toBe(0)
    expect(belowTen.status).toBe(0)
  })

  it('refuses to overwrite an existing dry-run report', () => {
    const directory = mkdtempSync(join(tmpdir(), 'filecoin-pin-payments-smoke-test-'))
    temporaryDirectories.push(directory)
    const output = join(directory, 'report.json')
    const args = [
      resolve('scripts/payments-smoke-test.mjs'),
      '--network',
      'devnet',
      '--flow',
      'setup',
      '--deposit',
      '1',
      '--output',
      output,
    ]
    const first = spawnSync(process.execPath, args, { encoding: 'utf8', env: harnessEnv() })
    const original = readFileSync(output, 'utf8')
    const second = spawnSync(process.execPath, args, { encoding: 'utf8', env: harnessEnv() })

    expect(first.status).toBe(0)
    expect(second.status).toBe(1)
    expect(readFileSync(output, 'utf8')).toBe(original)
  })

  it('fails closed before execution when RPC_URL does not match the requested network', async () => {
    const rpcUrl = await startRpcServer(314)
    const directory = mkdtempSync(join(tmpdir(), 'filecoin-pin-payments-smoke-test-'))
    temporaryDirectories.push(directory)
    const output = join(directory, 'must-not-exist.json')
    const result = spawnSync(
      process.execPath,
      [
        resolve('scripts/payments-smoke-test.mjs'),
        '--network',
        'calibration',
        '--flow',
        'fund',
        '--amount',
        '2',
        '--execute',
        '--output',
        output,
      ],
      { encoding: 'utf8', env: harnessEnv({ RPC_URL: rpcUrl }) }
    )

    expect(result.status).toBe(1)
    expect(`${result.stdout}${result.stderr}`).toContain(
      'RPC_URL chain ID 314 does not match requested calibration chain ID 314159'
    )
    expect(existsSync(output)).toBe(false)
  })

  it('persists requested state before an unfunded fake mainnet child and atomically redacts its completion output', async () => {
    const rpcUrl = await startRpcServer(314)
    const directory = mkdtempSync(join(tmpdir(), 'filecoin-pin-payments-smoke-test-'))
    temporaryDirectories.push(directory)
    const distDirectory = join(directory, 'dist')
    const outputDirectory = join(directory, 'existing-output')
    const output = join(outputDirectory, 'report.json')
    mkdirSync(distDirectory)
    mkdirSync(outputDirectory)
    if (supportsPOSIXModes) chmodSync(outputDirectory, 0o755)
    writeFileSync(
      join(distDirectory, 'cli.js'),
      [
        "import { existsSync, readFileSync } from 'node:fs'",
        'const reportPath = process.env.SMOKE_TEST_REPORT',
        'if (reportPath == null || !existsSync(reportPath)) process.exit(21)',
        "const report = JSON.parse(readFileSync(reportPath, 'utf8'))",
        "if (report.execution !== 'requested') process.exit(22)",
        "if (process.argv.includes('--network')) process.exit(23)",
        'if (process.env.NETWORK != null) process.exit(24)',
        "console.log('private=' + process.env.PRIVATE_KEY + ' integrator=' + process.env.SQUID_INTEGRATOR_ID + ' rpc=' + process.env.RPC_URL + ' path=https://provider.example.test/v2/path-secret/status')",
        "console.error('source=' + process.env.SOURCE_RPC_URL)",
      ].join('\n')
    )
    const result = spawnSync(
      process.execPath,
      [
        resolve('scripts/payments-smoke-test.mjs'),
        '--network',
        'mainnet',
        '--flow',
        'fund',
        '--amount',
        '2',
        '--source-cap',
        '5',
        '--execute',
        '--ack-mainnet',
        '--output',
        output,
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        env: harnessEnv({
          SMOKE_TEST_REPORT: output,
          NETWORK: 'calibration',
          PRIVATE_KEY: '0xfake-private-key',
          RPC_URL: `${rpcUrl}/v2/filecoin-password/rpc?token=filecoin-token`,
          SOURCE_RPC_URL: 'https://arb-user:arb-password@example.test/rpc?token=arb-token',
          SQUID_INTEGRATOR_ID: 'fake-integrator-id',
        }),
      }
    )
    const report = JSON.parse(readFileSync(output, 'utf8')) as Record<string, unknown>
    const reportText = JSON.stringify(report)

    expect(result.status).toBe(0)
    expect(report).toMatchObject({
      execution: 'completed',
      exitCode: 0,
      sourceCapUSDC: '5',
      sourceNativeGasCapArbitrumETH: '0.0001',
    })
    expect(report).toHaveProperty('completedAt')
    expect(report.command).not.toContain('--network')
    if (supportsPOSIXModes) {
      expect(statSync(output).mode & 0o777).toBe(0o600)
      expect(statSync(outputDirectory).mode & 0o777).toBe(0o755)
    }
    for (const secret of [
      '0xfake-private-key',
      'fake-integrator-id',
      'filecoin-password',
      'filecoin-token',
      'arb-password',
      'arb-token',
      'path-secret',
    ]) {
      expect(reportText).not.toContain(secret)
    }
    expect(reportText).toContain('[redacted PRIVATE_KEY]')
    expect(reportText).toContain('[redacted SQUID_INTEGRATOR_ID]')
    expect(reportText).toContain('[redacted RPC_URL]')
    expect(reportText).toContain('[redacted SOURCE_RPC_URL]')
    expect(reportText).toContain('[redacted URL]')
  })
})
