#!/usr/bin/env node

/**
 * Produce a sanitized release-evidence artifact and, only with explicit
 * consent, run the built CLI smoke command. No package.json script calls this,
 * so normal CI never runs a funded smoke.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { createPublicClient, http, webSocket } from 'viem'

const allowedNetworks = new Set(['devnet', 'calibration', 'mainnet'])
const allowedFlows = new Set(['fund', 'setup'])
const networkChainIds = { calibration: 314159, devnet: 31415926, mainnet: 314 }
const usdcBaseUnits = 1_000_000n
const maxMainnetSourceCapUSDC = 10_000_000n

function usage(message) {
  if (message != null) process.stderr.write(`Error: ${message}\n`)
  process.stderr.write(
    'Usage: node scripts/release-evidence.mjs --network <devnet|calibration|mainnet> --flow <fund|setup> (--deposit <USDFC> | --amount <USDFC> | --days <days>) [--mode <minimum|exact>] [--source-cap <USDC>] [--execute --ack-mainnet] [--output <path>]\n'
  )
  process.exitCode = message == null ? 0 : 1
}

function valueAfter(args, index, argument) {
  const value = args[index + 1]
  if (value == null || value.startsWith('--')) {
    usage(`${argument} requires a value`)
    return undefined
  }
  return value
}

function parseArgs(args) {
  const options = { execute: false, ackMainnet: false }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--execute') {
      options.execute = true
      continue
    }
    if (argument === '--ack-mainnet') {
      options.ackMainnet = true
      continue
    }
    if (argument === '--help' || argument === '-h') {
      usage()
      return undefined
    }
    const value = valueAfter(args, index, argument)
    if (value == null) return undefined
    if (argument === '--network') options.network = value
    else if (argument === '--flow') options.flow = value
    else if (argument === '--deposit') options.deposit = value
    else if (argument === '--amount') options.amount = value
    else if (argument === '--days') options.days = value
    else if (argument === '--mode') options.mode = value
    else if (argument === '--source-cap') options.sourceCap = value
    else if (argument === '--output') options.output = value
    else {
      usage(`Unknown option ${argument}`)
      return undefined
    }
    index += 1
  }
  if (!allowedNetworks.has(options.network)) {
    usage('--network must be devnet, calibration, or mainnet')
    return undefined
  }
  if (!allowedFlows.has(options.flow)) {
    usage('--flow must be fund or setup')
    return undefined
  }
  if (options.flow === 'setup') {
    if (!isPositiveDecimal(options.deposit) || options.amount != null || options.days != null || options.mode != null) {
      usage('setup requires exactly one positive --deposit and does not accept --amount, --days, or --mode')
      return undefined
    }
  } else {
    if ((options.amount == null) === (options.days == null) || options.deposit != null) {
      usage('fund requires exactly one of --amount or --days and does not accept --deposit')
      return undefined
    }
    if (options.amount != null && !isPositiveDecimal(options.amount)) {
      usage('--amount must be a positive decimal amount')
      return undefined
    }
    if (options.days != null && (!/^\d+$/u.test(options.days) || Number(options.days) <= 0)) {
      usage('--days must be a positive whole number')
      return undefined
    }
    if (options.mode != null && !['minimum', 'exact'].includes(options.mode)) {
      usage('--mode must be minimum or exact')
      return undefined
    }
  }
  if (options.network === 'mainnet') {
    const sourceCapUSDC = parsePositiveUSDC(options.sourceCap)
    if (sourceCapUSDC == null) {
      usage('mainnet requires a positive --source-cap with at most six USDC decimal places, even for a dry run')
      return undefined
    }
    if (sourceCapUSDC > maxMainnetSourceCapUSDC) {
      usage('--source-cap must not exceed the 10 USDC release cap')
      return undefined
    }
    if (options.execute && !options.ackMainnet) {
      usage('mainnet execution also requires --ack-mainnet')
      return undefined
    }
  } else if (options.sourceCap != null || options.ackMainnet) {
    usage('--source-cap and --ack-mainnet are only valid for mainnet')
    return undefined
  }
  return options
}

function isPositiveDecimal(value) {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) && Number(value) > 0
}

function parsePositiveUSDC(value) {
  if (typeof value !== 'string') return undefined
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/u.exec(value)
  if (match == null) return undefined
  const whole = match[1]
  const fractional = match[2] ?? ''
  if (fractional.length > 6) return undefined
  const fractionalBaseUnits = BigInt(`${fractional}000000`.slice(0, 6))
  const baseUnits = BigInt(whole) * usdcBaseUnits + fractionalBaseUnits
  return baseUnits > 0n ? baseUnits : undefined
}

function commandFor(options) {
  const command = ['node', 'dist/cli.js', 'payments', options.flow]
  if (options.flow === 'setup') command.push('--auto', '--deposit', options.deposit)
  else if (options.amount != null) command.push('--amount', options.amount)
  else command.push('--days', options.days)
  if (options.mode != null) command.push('--mode', options.mode)
  if (process.env.RPC_URL == null || process.env.RPC_URL.trim() === '') {
    command.push('--network', options.network)
  }
  if (options.network === 'mainnet') {
    command.push('--from-chain', 'arb', '--from-token', 'USDC', '--max-source-amount', options.sourceCap)
  }
  return command
}

function sanitizedText(value) {
  let result = value
  for (const name of ['PRIVATE_KEY', 'SQUID_INTEGRATOR_ID', 'RPC_URL', 'SOURCE_RPC_URL']) {
    const secret = process.env[name]
    if (secret != null && secret !== '') result = result.replaceAll(secret, `[redacted ${name}]`)
  }
  return result.replace(/\b(?:https?|wss?):\/\/[^\s'"`<>]+/giu, '[redacted URL]')
}

async function verifyRpcNetwork(options) {
  const rpcUrl = process.env.RPC_URL?.trim()
  if (!options.execute || rpcUrl == null || rpcUrl === '') return

  const isWebSocket = /^wss?:\/\//iu.test(rpcUrl)
  if (!isWebSocket && !/^https?:\/\//iu.test(rpcUrl)) {
    throw new Error('RPC_URL must use http, https, ws, or wss for execute-time network verification')
  }

  const client = createPublicClient({
    transport: isWebSocket
      ? webSocket(rpcUrl, { keepAlive: false, reconnect: false, retryCount: 0, timeout: 10_000 })
      : http(rpcUrl, { retryCount: 0, timeout: 10_000 }),
  })
  let rpcClient
  try {
    if (isWebSocket) rpcClient = await client.transport.getRpcClient()
    const chainId = await client.getChainId()
    const expectedChainId = networkChainIds[options.network]
    if (chainId !== expectedChainId) {
      throw new Error(
        `RPC_URL chain ID ${chainId} does not match requested ${options.network} chain ID ${expectedChainId}; no CLI command was executed`
      )
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('does not match requested')) throw error
    throw new Error('Unable to verify that RPC_URL matches the requested network; no CLI command was executed')
  } finally {
    rpcClient?.close()
  }
}

function defaultOutput(network, flow) {
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  return resolve('artifacts', 'release-evidence', `${stamp}-${network}-${flow}.json`)
}

async function writeNewArtifact(output, artifact) {
  const directory = dirname(output)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}

async function updateArtifact(output, artifact) {
  const temporaryOutput = resolve(dirname(output), `.${basename(output)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporaryOutput, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    if (process.platform !== 'win32') await chmod(temporaryOutput, 0o600)
    await rename(temporaryOutput, output)
  } catch (error) {
    await unlink(temporaryOutput).catch(() => undefined)
    throw error
  }
}

async function run(command) {
  return await new Promise((resolveRun, rejectRun) => {
    const env = { ...process.env }
    if (env.RPC_URL != null && env.RPC_URL.trim() !== '') delete env.NETWORK
    const child = spawn(command[0], command.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', rejectRun)
    child.once('close', (exitCode) => resolveRun({ exitCode, stderr, stdout }))
  })
}

const options = parseArgs(process.argv.slice(2))
if (options != null) {
  const command = commandFor(options)
  const output = resolve(options.output ?? defaultOutput(options.network, options.flow))
  await verifyRpcNetwork(options)
  const artifact = {
    schemaVersion: '1.0',
    kind: 'filecoin-pin-release-evidence-run',
    createdAt: new Date().toISOString(),
    network: options.network,
    flow: options.flow,
    execution: options.execute ? 'requested' : 'dry-run',
    sourceCapUSDC: options.network === 'mainnet' ? options.sourceCap : null,
    sourceNativeGasCapArbitrumETH: options.network === 'mainnet' ? '0.0001' : null,
    command,
    safety: {
      noSecretsPersisted: true,
      normalCITestCoverageIncludesDryRunsAndUnfundedFakeChildExecuteOnly: true,
      normalCINeverRunsRealCLIOrFundedSmoke: true,
      fundedSmokeRequiresExplicitExecute: true,
      mainnetRequiresExplicitExecuteExactSourceCapAndAcknowledgement: true,
    },
  }
  await writeNewArtifact(output, artifact)

  if (options.execute) {
    if (!existsSync(resolve('dist', 'cli.js'))) {
      throw new Error('Build the CLI first with pnpm run build; dist/cli.js is required for an execute run')
    }
    const result = await run(command)
    artifact.execution = 'completed'
    artifact.exitCode = result.exitCode
    artifact.stdout = sanitizedText(result.stdout)
    artifact.stderr = sanitizedText(result.stderr)
    artifact.completedAt = new Date().toISOString()
    await updateArtifact(output, artifact)
    process.exitCode = result.exitCode ?? 1
  }

  process.stdout.write(
    `${JSON.stringify({ artifact: basename(output), execution: artifact.execution, flow: artifact.flow, network: artifact.network })}\n`
  )
}
