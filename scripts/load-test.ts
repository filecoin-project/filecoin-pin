#!/usr/bin/env tsx
/**
 * Load Test for filecoin-pin-website
 *
 * Simulates 10-200 concurrent users uploading unique files to test reliability.
 * Each simulated user:
 * - Creates a new dataset (simulates isolated browser sessions)
 * - Uploads a unique file (so IPNI has no previous providers)
 * - Verifies expected links within timeout
 * - Tags all transactions with 'load-test' in Sentry for filtering
 *
 * Usage:
 *   tsx scripts/load-test.ts --users 10
 *   tsx scripts/load-test.ts --users 50 --timeout 300000
 *   tsx scripts/load-test.ts --users 10 --rpc-url https://api.calibration.node.glif.io/rpc/v1
 *
 * Environment Variables Required:
 *   SESSION_KEY - Session key for authentication
 *   WALLET_ADDRESS - Wallet address for session key auth
 */

import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import type { Synapse } from '@filoz/synapse-sdk'
import { CID } from 'multiformats/cid'
import pino from 'pino'
import { cleanupProvider, createStorageContext, initializeSynapse } from '../src/core/synapse/index.js'
import { cleanupTempCar, createUnixfsCarBuilder } from '../src/core/unixfs/index.js'
import { executeUpload } from '../src/core/upload/index.js'
import type { UploadExecutionOptions } from '../src/core/upload/index.js'

// Increase listener limit because each simulated user initializes telemetry hooks
process.setMaxListeners(0)

// ============================================================================
// Configuration
// ============================================================================

interface LoadTestConfig {
  /** Number of concurrent users to simulate */
  users: number
  /** Maximum time to wait for upload completion (ms) */
  timeout: number
  /** RPC URL override */
  rpcUrl?: string
  /** Test run ID for grouping in Sentry */
  testRunId: string
}

interface LoadTestResult {
  userId: number
  success: boolean
  dataSetId?: number
  ipfsRootCid?: CID
  pieceCid?: string
  transactionHash?: string
  providerId?: number
  providerName?: string
  providerAddress?: string
  ipniValidated?: boolean
  linksVerified?: boolean
  links?: {
    proofs: string
    piece: string
    ipfs: string
    ipfsDownload: string
  }
  error?: string
  duration: number
}

interface CarArtifact {
  userId: number
  fileName: string
  filePath: string
  carPath: string
  ipfsRootCid: CID
}

const STAGE_LABELS = {
  carPrebuilt: 'CAR Ready',
  synapseInit: 'Synapse Initializing',
  synapseReady: 'Synapse Ready',
  datasetCreating: 'Dataset Creating',
  datasetReady: 'Dataset Ready',
  uploadStarting: 'Upload Starting',
  uploadInFlight: 'Upload In Flight',
  pieceAdded: 'Piece Added',
  pieceConfirmed: 'Piece Confirmed',
  ipniValidation: 'IPNI Validation',
  ipniValidated: 'IPNI Validated',
  linksVerifying: 'Link Verification',
  linksVerified: 'Links Verified',
  completed: 'Completed',
  failed: 'Failed',
} as const

type StageKey = keyof typeof STAGE_LABELS
const STAGE_KEYS = Object.keys(STAGE_LABELS) as StageKey[]

class StageTracker {
  private currentStage = new Map<number, StageKey>()
  private currentCounts = new Map<StageKey, number>()
  private maxCounts = new Map<StageKey, number>()
  private userProvider = new Map<number, string>()
  private providerCounts = new Map<string, Map<StageKey, number>>()
  private providerMaxCounts = new Map<string, Map<StageKey, number>>()

  constructor() {
    for (const stage of STAGE_KEYS) {
      this.currentCounts.set(stage, 0)
      this.maxCounts.set(stage, 0)
    }
  }

  setUserProvider(userId: number, providerName: string): void {
    this.userProvider.set(userId, providerName)

    // Initialize provider tracking
    if (!this.providerCounts.has(providerName)) {
      const stageCounts = new Map<StageKey, number>()
      const stageMaxCounts = new Map<StageKey, number>()
      for (const stage of STAGE_KEYS) {
        stageCounts.set(stage, 0)
        stageMaxCounts.set(stage, 0)
      }
      this.providerCounts.set(providerName, stageCounts)
      this.providerMaxCounts.set(providerName, stageMaxCounts)
    }
  }

  enterStage(userId: number, stage: StageKey): void {
    const previous = this.currentStage.get(userId)
    if (previous === stage) {
      return
    }
    if (previous) {
      this.adjustCount(previous, -1, userId)
    }
    this.adjustCount(stage, 1, userId)
    this.currentStage.set(userId, stage)
  }

  private adjustCount(stage: StageKey, delta: number, userId: number): void {
    // Track global counts
    const next = Math.max(0, (this.currentCounts.get(stage) ?? 0) + delta)
    this.currentCounts.set(stage, next)
    const previousMax = this.maxCounts.get(stage) ?? 0
    if (delta > 0 && next > previousMax) {
      this.maxCounts.set(stage, next)
    }

    // Track per-provider counts
    const providerName = this.userProvider.get(userId)
    if (providerName) {
      const providerStageCounts = this.providerCounts.get(providerName)
      const providerStageMaxCounts = this.providerMaxCounts.get(providerName)

      if (providerStageCounts && providerStageMaxCounts) {
        const providerNext = Math.max(0, (providerStageCounts.get(stage) ?? 0) + delta)
        providerStageCounts.set(stage, providerNext)

        const providerPreviousMax = providerStageMaxCounts.get(stage) ?? 0
        if (delta > 0 && providerNext > providerPreviousMax) {
          providerStageMaxCounts.set(stage, providerNext)
        }
      }
    }
  }

  getMaxSummaries(): Array<{ stage: StageKey; label: string; max: number }> {
    return STAGE_KEYS.map((stage) => ({
      stage,
      label: STAGE_LABELS[stage],
      max: this.maxCounts.get(stage) ?? 0,
    }))
  }

  getProviderMaxSummaries(): Map<string, Array<{ stage: StageKey; label: string; max: number }>> {
    const result = new Map<string, Array<{ stage: StageKey; label: string; max: number }>>()

    for (const [providerName, maxCounts] of this.providerMaxCounts.entries()) {
      const summaries = STAGE_KEYS.map((stage) => ({
        stage,
        label: STAGE_LABELS[stage],
        max: maxCounts.get(stage) ?? 0,
      })).filter((s) => s.max > 0)

      if (summaries.length > 0) {
        result.set(providerName, summaries)
      }
    }

    return result
  }
}

// ============================================================================
// Parse CLI Arguments
// ============================================================================

function parseArgs(): LoadTestConfig {
  const args = process.argv.slice(2)
  const config: LoadTestConfig = {
    users: 10,
    timeout: 5 * 60 * 1000, // 5 minutes default
    testRunId: `load-test-${Date.now()}`,
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--users':
      case '-u':
        config.users = Number.parseInt(args[++i], 10)
        if (Number.isNaN(config.users) || config.users < 1) {
          throw new Error('--users must be a positive integer')
        }
        break
      case '--timeout':
      case '-t':
        config.timeout = Number.parseInt(args[++i], 10)
        if (Number.isNaN(config.timeout) || config.timeout < 1000) {
          throw new Error('--timeout must be at least 1000ms')
        }
        break
      case '--rpc-url':
        config.rpcUrl = args[++i]
        break
      case '--help':
      case '-h':
        console.log(
          `
Load Test for filecoin-pin-website

Usage: tsx scripts/load-test.ts [options]

Options:
  -u, --users <n>       Number of concurrent users (default: 10)
  -t, --timeout <ms>    Upload timeout in milliseconds (default: 300000)
  --rpc-url <url>       Override RPC URL
  -h, --help            Show this help message

Environment Variables:
  SESSION_KEY      Session key for authentication (required)
  WALLET_ADDRESS   Wallet address (required)

Examples:
  tsx scripts/load-test.ts --users 10
  tsx scripts/load-test.ts --users 50 --timeout 600000
  tsx scripts/load-test.ts --rpc-url https://api.calibration.node.glif.io/rpc/v1
        `.trim()
        )
        process.exit(0)
      default:
        console.error(`Unknown argument: ${args[i]}`)
        process.exit(1)
    }
  }

  return config
}

// ============================================================================
// Link Generation (matching website utils/links.ts)
// ============================================================================

function getDatasetExplorerLink(dataSetId: number): string {
  return `https://pdp.vxb.ai/calibration/dataset/${dataSetId}`
}

function getPieceExplorerLink(pieceCid: string): string {
  return `https://pdp.vxb.ai/calibration/piece/${pieceCid}`
}

function getIpfsGatewayRenderLink(cid: string): string {
  return `https://dweb.link/ipfs/${cid}`
}

function getIpfsGatewayDownloadLink(cid: string, fileName: string): string {
  return `https://dweb.link/ipfs/${cid}?filename=${fileName}.car`
}

// ============================================================================
// Helpers
// ============================================================================

const LINK_POLL_INTERVAL_MS = 5_000
const FETCH_ATTEMPT_TIMEOUT_MS = 15_000

const LINK_LABELS = {
  proofs: 'Proofs explorer link',
  piece: 'Piece explorer link',
  ipfs: 'IPFS gateway link',
  ipfsDownload: 'IPFS CAR download link',
} as const

type LinkKey = keyof typeof LINK_LABELS

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function probeUrl(
  url: string,
  label: string,
  logger: pino.Logger,
  method: 'HEAD' | 'GET',
  headers?: Record<string, string>
): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_ATTEMPT_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method,
      headers,
      redirect: 'follow',
      signal: controller.signal,
    })

    // Drain the body quickly if present to avoid dangling streams
    if (!response.bodyUsed && response.body) {
      try {
        await response.body.cancel()
      } catch {
        // ignore body cancel errors
      }
    }

    if (response.ok) {
      logger.debug({ url, status: response.status }, `${label} responded with success`)
      return true
    }

    logger.debug({ url, status: response.status }, `${label} not ready yet (HTTP ${response.status})`)

    // Retry with GET when HEAD is not supported
    if (method === 'HEAD' && (response.status === 404 || response.status === 405)) {
      return false
    }

    return false
  } catch (error) {
    logger.debug({ url, error }, `${label} request failed`)
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForLinkAvailability(
  key: LinkKey,
  url: string,
  logger: pino.Logger,
  timeoutMs: number
): Promise<void> {
  const label = LINK_LABELS[key]
  const deadline = Date.now() + timeoutMs

  // Prefer HEAD requests for gateway checks to avoid large payloads,
  // but fall back to GET (with range) when needed.
  const strategies: Array<{ method: 'HEAD' | 'GET'; headers?: Record<string, string> }> = [
    { method: key === 'proofs' || key === 'piece' ? 'GET' : 'HEAD' },
  ]

  if (key === 'ipfs' || key === 'ipfsDownload') {
    strategies.push({
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
    })
  }

  logger.info({ url, timeoutMs }, `Waiting for ${label}`)

  while (Date.now() < deadline) {
    for (const strategy of strategies) {
      const available = await probeUrl(url, label, logger, strategy.method, strategy.headers)
      if (available) {
        logger.info({ url }, `${label} verified`)
        return
      }
    }

    await delay(LINK_POLL_INTERVAL_MS)
  }

  throw new Error(`Timed out waiting for ${label}`)
}

async function verifyLinks(links: Record<LinkKey, string>, logger: pino.Logger, timeoutMs: number): Promise<void> {
  await Promise.all(
    (Object.keys(links) as LinkKey[]).map((key) => waitForLinkAvailability(key, links[key], logger, timeoutMs))
  )
}

async function cleanupSynapseResources(synapse: Synapse | null, logger: pino.Logger): Promise<void> {
  if (!synapse) return

  try {
    await synapse.telemetry?.sentry?.close()
  } catch (error) {
    logger.warn({ error }, 'Failed to flush Synapse telemetry')
  }

  try {
    const provider = synapse.getProvider?.()
    if (provider) {
      await cleanupProvider(provider)
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to cleanup Synapse provider')
  }
}

async function prebuildCarArtifacts(
  count: number,
  testRunId: string,
  logger: pino.Logger,
  stageTracker: StageTracker
): Promise<CarArtifact[]> {
  const tempDir = '/tmp/filecoin-load-test'
  if (!existsSync(tempDir)) {
    await mkdir(tempDir, { recursive: true })
  }

  const artifacts: CarArtifact[] = []

  for (let i = 1; i <= count; i++) {
    const userId = i
    const fileName = `load-test-user-${userId}-${testRunId}.txt`
    const filePath = `${tempDir}/${fileName}`

    const uniqueContent = `
Load Test File
==============
User ID: ${userId}
Test Run: ${testRunId}
Timestamp: ${new Date().toISOString()}
Random Data: ${randomBytes(32).toString('hex')}

This file was generated as part of a load test for filecoin-pin-website.
Each user creates a unique file to ensure IPNI has no previous providers.
    `.trim()

    await writeFile(filePath, uniqueContent, 'utf-8')
    logger.info({ userId, filePath }, 'Created prebuilt test file')

    const builder = createUnixfsCarBuilder()
    const { carPath, rootCid } = await builder.buildCar(filePath)
    const ipfsRootCid = CID.parse(rootCid.toString())

    logger.info({ userId, carPath, ipfsRootCid }, 'Prebuilt CAR file')

    artifacts.push({
      userId,
      fileName,
      filePath,
      carPath,
      ipfsRootCid,
    })

    stageTracker.enterStage(userId, 'carPrebuilt')
  }

  return artifacts
}

// ============================================================================
// User Simulation
// ============================================================================

async function simulateUser(
  userId: number,
  config: LoadTestConfig,
  logger: pino.Logger,
  artifact: CarArtifact,
  stageTracker: StageTracker
): Promise<LoadTestResult> {
  const startTime = Date.now()
  const userLogger = logger.child({ userId, testRunId: config.testRunId })
  let filePath: string | undefined
  let carPath: string | undefined
  let ipfsRootCid: CID | undefined
  let dataSetId: number | undefined
  let providerId: number | undefined
  let providerName: string | undefined
  let providerAddress: string | undefined
  let pieceCid: string | undefined
  let transactionHash: string | undefined
  let links: LoadTestResult['links']
  let ipniValidated: boolean | undefined
  let linksVerified: boolean | undefined
  let synapse: Synapse | null = null

  try {
    userLogger.info('Starting user simulation')
    stageTracker.enterStage(userId, 'synapseInit')

    // auth input is validated in initializeSynapse
    const sessionKey = process.env.SESSION_KEY
    const walletAddress = process.env.WALLET_ADDRESS
    const privateKey = process.env.PRIVATE_KEY

    // 2. Use prebuilt test file + CAR artifact
    filePath = artifact.filePath
    carPath = artifact.carPath
    ipfsRootCid = artifact.ipfsRootCid
    const fileName = artifact.fileName
    userLogger.info({ filePath, carPath, ipfsRootCid }, 'Using prebuilt CAR artifact')

    // 3. Initialize Synapse with Sentry tags for filtering
    userLogger.info('Initializing Synapse with load-test tags')
    synapse = await initializeSynapse(
      {
        privateKey,
        sessionKey,
        walletAddress,
        rpcUrl: config.rpcUrl,
        telemetry: {
          sentrySetTags: {
            // Critical: These tags allow filtering in Sentry dashboards
            'load-test': 'true',
            'test-run-id': config.testRunId,
            'user-id': userId.toString(),
          },
        },
      },
      userLogger
    )

    userLogger.info('Synapse initialized')
    stageTracker.enterStage(userId, 'synapseReady')

    // 4. Create NEW dataset (simulates new user with isolated storage)
    userLogger.info('Creating new dataset')
    stageTracker.enterStage(userId, 'datasetCreating')
    const { storage, providerInfo } = await createStorageContext(synapse, userLogger, {
      dataset: {
        createNew: true, // Forces new dataset per user
        metadata: {
          'load-test': 'true',
          'test-run-id': config.testRunId,
          'user-id': userId.toString(),
        },
      },
    })

    // const dataSetId = storage.dataSetId
    userLogger.info({ dataSetId: storage.dataSetId, provider: providerInfo.name }, 'Dataset created')
    stageTracker.enterStage(userId, 'datasetReady')
    dataSetId = storage.dataSetId != null ? Number(storage.dataSetId) : undefined
    providerId = providerInfo.id
    providerName = providerInfo.name
    providerAddress = providerInfo.serviceProvider

    // Track provider for this user
    if (providerName) {
      stageTracker.setUserProvider(userId, providerName)
    }

    if (!carPath) {
      throw new Error('Failed to resolve CAR file path')
    }
    if (!ipfsRootCid) {
      throw new Error('Failed to resolve IPFS root CID')
    }

    const carData = await readFile(carPath)

    // 6. Execute upload with timeout
    userLogger.info('Starting upload')
    stageTracker.enterStage(userId, 'uploadStarting')
    const stageAwareProgress: UploadExecutionOptions['onProgress'] = (event) => {
      switch (event.type) {
        case 'onPieceAdded':
          stageTracker.enterStage(userId, 'pieceAdded')
          stageTracker.enterStage(userId, 'ipniValidation')
          break
        case 'onPieceConfirmed':
          stageTracker.enterStage(userId, 'pieceConfirmed')
          break
        case 'ipniAdvertisement.retryUpdate':
          stageTracker.enterStage(userId, 'ipniValidation')
          break
        case 'ipniAdvertisement.complete':
          stageTracker.enterStage(userId, 'ipniValidated')
          break
        case 'ipniAdvertisement.failed':
          stageTracker.enterStage(userId, 'failed')
          break
        default:
          break
      }
    }
    stageTracker.enterStage(userId, 'uploadInFlight')
    const uploadPromise = executeUpload({ synapse, storage, providerInfo }, carData, ipfsRootCid, {
      logger: userLogger,
      contextId: `load-test-user-${userId}`,
      metadata: {
        'load-test': 'true',
        'test-run-id': config.testRunId,
        'user-id': userId.toString(),
      },
      ipniValidation: {
        enabled: true,
      },
      onProgress: stageAwareProgress,
    })

    const timeoutError = new Error('Upload timeout exceeded')
    let timeoutId: NodeJS.Timeout | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(timeoutError), config.timeout)
    })

    let result: Awaited<ReturnType<typeof executeUpload>>
    try {
      result = await Promise.race([uploadPromise, timeoutPromise])
    } catch (error) {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
      if (error === timeoutError) {
        uploadPromise.catch((uploadError) => {
          userLogger.warn({ error: uploadError }, 'Upload promise rejected after timeout')
        })
      }
      throw error
    }

    if (timeoutId) {
      clearTimeout(timeoutId)
    }
    dataSetId = Number(result.dataSetId)
    pieceCid = result.pieceCid
    transactionHash = result.transactionHash
    ipniValidated = result.ipniValidated

    // 7. Generate expected links (matching website behavior)
    links = {
      proofs: getDatasetExplorerLink(dataSetId),
      piece: getPieceExplorerLink(result.pieceCid),
      ipfs: getIpfsGatewayRenderLink(ipfsRootCid.toString()),
      ipfsDownload: getIpfsGatewayDownloadLink(ipfsRootCid.toString(), fileName),
    }

    userLogger.info(
      {
        dataSetId,
        ipfsRootCid,
        pieceCid: result.pieceCid,
        transactionHash: result.transactionHash,
        ipniValidated: result.ipniValidated,
        links,
      },
      'Upload completed successfully'
    )

    const elapsed = Date.now() - startTime
    const verificationTimeout = Math.max(5_000, config.timeout - elapsed)
    stageTracker.enterStage(userId, 'linksVerifying')
    await verifyLinks(
      {
        proofs: links.proofs,
        piece: links.piece,
        ipfs: links.ipfs,
        ipfsDownload: links.ipfsDownload,
      },
      userLogger,
      verificationTimeout
    )
    stageTracker.enterStage(userId, 'linksVerified')

    const duration = Date.now() - startTime
    linksVerified = true
    const didValidate = result.ipniValidated === true
    const success = didValidate && linksVerified
    const failureReason = success ? undefined : 'IPNI validation did not complete before timeout'
    ipniValidated = didValidate
    stageTracker.enterStage(userId, success ? 'completed' : 'failed')

    return {
      userId,
      success,
      dataSetId,
      ipfsRootCid,
      pieceCid,
      transactionHash,
      providerId,
      providerName,
      providerAddress,
      ipniValidated,
      linksVerified,
      links,
      ...(failureReason ? { error: failureReason } : {}),
      duration,
    }
  } catch (error) {
    const duration = Date.now() - startTime
    userLogger.error({ error, duration }, 'User simulation failed')
    stageTracker.enterStage(userId, 'failed')

    return {
      userId,
      success: false,
      dataSetId,
      ipfsRootCid,
      pieceCid,
      transactionHash,
      providerId,
      providerName,
      providerAddress,
      ipniValidated,
      linksVerified,
      links,
      error: error instanceof Error ? error.message : String(error),
      duration,
    }
  } finally {
    const cleanupPromises: Array<Promise<void>> = []

    // Clean up file and CAR artifacts
    if (filePath) {
      cleanupPromises.push(
        (async () => {
          try {
            await unlink(filePath)
          } catch (err) {
            userLogger.warn({ error: err, filePath }, 'Failed to delete test file')
          }
        })()
      )
    }

    if (carPath) {
      cleanupPromises.push(
        (async () => {
          try {
            await cleanupTempCar(carPath, userLogger)
          } catch (err) {
            userLogger.warn({ error: err, carPath }, 'Failed to cleanup CAR file')
          }
        })()
      )
    }

    if (synapse) {
      cleanupPromises.push(cleanupSynapseResources(synapse, userLogger))
    }

    await Promise.allSettled(cleanupPromises)
  }
}

// ============================================================================
// Main Load Test Runner
// ============================================================================

async function runLoadTest() {
  const config = parseArgs()

  // Create logger for terminal output
  const logger = pino({
    level: 'info',
  })
  const stageTracker = new StageTracker()

  logger.info(
    {
      users: config.users,
      timeout: `${config.timeout / 1000}s`,
      rpcUrl: config.rpcUrl || 'default',
      testRunId: config.testRunId,
    },
    '🚀 Starting load test'
  )

  // Validate environment
  if (!process.env.SESSION_KEY || !process.env.WALLET_ADDRESS) {
    logger.error('Missing required environment variables: SESSION_KEY, WALLET_ADDRESS')
    process.exit(1)
  }

  logger.info('⚠️  All transactions will be tagged with "load-test=true" in Sentry for filtering')

  logger.info('🧱 Prebuilding CAR artifacts before starting uploads')
  const artifacts = await prebuildCarArtifacts(config.users, config.testRunId, logger, stageTracker)

  const startTime = Date.now()

  // Launch all user simulations concurrently
  // Use allSettled to ensure we get all results even if some throw unexpectedly
  const settledResults = await Promise.allSettled(
    artifacts.map((artifact) => simulateUser(artifact.userId, config, logger, artifact, stageTracker))
  )

  const totalDuration = Date.now() - startTime

  // Extract results from settled promises
  const results: LoadTestResult[] = settledResults.map((settled, i) => {
    if (settled.status === 'fulfilled') {
      return settled.value
    }
    // If simulateUser threw unexpectedly (shouldn't happen due to try-catch, but defensive)
    logger.error({ userId: i + 1, error: settled.reason }, 'User simulation threw unexpected error')
    return {
      userId: i + 1,
      success: false,
      error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
      duration: 0,
    }
  })

  // ============================================================================
  // Results Summary
  // ============================================================================

  const successful = results.filter((r) => r.success)
  const failed = results.filter((r) => !r.success)

  // ============================================================================
  // Save Results to JSON File
  // ============================================================================

  const resultsFile = `/tmp/filecoin-load-test/results-${config.testRunId}.json`
  const resultsData = {
    testRunId: config.testRunId,
    config: {
      users: config.users,
      timeout: config.timeout,
      rpcUrl: config.rpcUrl || 'default',
    },
    summary: {
      totalUsers: config.users,
      successful: successful.length,
      failed: failed.length,
      successRate: (successful.length / config.users) * 100,
      totalDuration,
      avgDuration: results.reduce((sum, r) => sum + r.duration, 0) / results.length,
    },
    results,
  }

  try {
    await writeFile(resultsFile, JSON.stringify(resultsData, null, 2), 'utf-8')
    logger.info({ resultsFile }, 'Results saved to file')
  } catch (error) {
    logger.warn({ error, resultsFile }, 'Failed to save results file')
  }

  console.log(`\n${'='.repeat(80)}`)
  console.log('Load Test Results')
  console.log('='.repeat(80))
  console.log(`Test Run ID: ${config.testRunId}`)
  console.log(`Total Users: ${config.users}`)
  console.log(`Successful: ${successful.length} (${((successful.length / config.users) * 100).toFixed(1)}%)`)
  console.log(`Failed: ${failed.length} (${((failed.length / config.users) * 100).toFixed(1)}%)`)
  console.log(`Total Duration: ${(totalDuration / 1000).toFixed(1)}s`)
  console.log(`Avg Duration: ${(results.reduce((sum, r) => sum + r.duration, 0) / results.length / 1000).toFixed(1)}s`)
  console.log('='.repeat(80))

  if (successful.length > 0) {
    console.log('\n✅ Successful Uploads:')
    for (const result of successful) {
      console.log(`  User ${result.userId}:`)
      console.log(`    Dataset: ${result.dataSetId}`)
      console.log(`    Root CID: ${result.ipfsRootCid}`)
      console.log(`    Piece CID: ${result.pieceCid}`)
      console.log(`    Duration: ${(result.duration / 1000).toFixed(1)}s`)
      console.log(`    Links:`)
      console.log(`      Proofs: ${result.links?.proofs}`)
      console.log(`      Piece: ${result.links?.piece}`)
      console.log(`      IPFS: ${result.links?.ipfs}`)
      console.log(`      Download: ${result.links?.ipfsDownload}`)
      console.log('')
    }
  }

  if (failed.length > 0) {
    console.log('\n❌ Failed Uploads:')
    for (const result of failed) {
      console.log(`  User ${result.userId}: ${result.error}`)
      console.log(`    Duration: ${(result.duration / 1000).toFixed(1)}s`)
    }
  }

  console.log(`\n${'='.repeat(80)}`)
  console.log('Sentry Filtering')
  console.log('='.repeat(80))
  console.log('To filter these transactions in Sentry, use:')
  console.log(`  load-test:true`)
  console.log(`  test-run-id:${config.testRunId}`)
  console.log('='.repeat(80))

  const stagePeaks = stageTracker.getMaxSummaries().filter((summary) => summary.max > 0)
  if (stagePeaks.length > 0) {
    console.log(`\n${'='.repeat(80)}`)
    console.log('Stage Concurrency Peaks')
    console.log('='.repeat(80))
    for (const summary of stagePeaks) {
      console.log(`  ${summary.label}: ${summary.max}`)
    }
    console.log('='.repeat(80))
  }

  const providerPeaks = stageTracker.getProviderMaxSummaries()
  if (providerPeaks.size > 0) {
    console.log(`\n${'='.repeat(80)}`)
    console.log('Per-Provider Concurrency Peaks')
    console.log('='.repeat(80))
    for (const [providerName, summaries] of providerPeaks.entries()) {
      console.log(`${providerName}:`)
      for (const summary of summaries) {
        console.log(`  ${summary.label}: ${summary.max}`)
      }
    }
    console.log('='.repeat(80))
  }

  console.log(`\n${'='.repeat(80)}`)
  console.log('Full Results')
  console.log('='.repeat(80))
  console.log(`Detailed results saved to: ${resultsFile}`)
  console.log(`View with: cat ${resultsFile} | jq .`)
  console.log(`${'='.repeat(80)}\n`)

  // Exit with error code if any uploads failed
  process.exit(failed.length > 0 ? 1 : 0)
}

// ============================================================================
// Entry Point
// ============================================================================

runLoadTest().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
