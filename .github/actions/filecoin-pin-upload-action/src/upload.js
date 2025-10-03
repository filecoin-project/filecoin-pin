import { access } from 'node:fs/promises'
import pc from 'picocolors'
import pino from 'pino'
import { commentOnPR } from './comments/comment.js'
import { getGlobalContext, mergeAndSaveContext } from './context.js'
import { cleanupSynapse, handlePayments, initializeSynapse, uploadCarToFilecoin } from './filecoin.js'
import { ensurePullRequestContext } from './github.js'
import { parseInputs } from './inputs.js'
import { writeOutputs, writeSummary } from './outputs.js'

/**
 * @typedef {import('./types.js').CombinedContext} CombinedContext
 * @typedef {import('./types.js').ParsedInputs} ParsedInputs
 * @typedef {import('./types.js').UploadResult} UploadResult
 * @typedef {import('./types.js').PaymentStatus} PaymentStatus
 */

/**
 * Run upload phase: Upload to Filecoin using context data from build phase
 */
export async function runUpload() {
  const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

  console.log('━━━ Upload Phase: Uploading to Filecoin ━━━')

  // Parse inputs (upload phase needs wallet)
  /** @type {ParsedInputs} */
  const inputs = parseInputs('upload')
  const {
    walletPrivateKey,
    contentPath,
    network: inputNetwork,
    minStorageDays,
    filecoinPayBalanceLimit,
    withCDN,
    providerAddress,
    dryRun,
  } = inputs

  // Ensure we have PR context available when running from workflow_run
  await ensurePullRequestContext()

  // Get context from build phase (already in memory from same workflow run)
  /** @type {Partial<CombinedContext>} */
  let ctx = getGlobalContext()
  console.log('[context-debug] Loaded context from build phase:', ctx)

  // Check if this was a fork PR that was blocked
  if (ctx.uploadStatus === 'fork-pr-blocked') {
    console.log('━━━ Fork PR Upload Blocked ━━━')
    console.log('::notice::Fork PR detected - content built but not uploaded to Filecoin, will comment on PR')

    const rootCid = ctx.ipfsRootCid || ''

    // Write outputs indicating fork PR was blocked
    await writeOutputs({
      ipfsRootCid: rootCid,
      dataSetId: '',
      pieceCid: '',
      providerId: '',
      providerName: '',
      carPath: ctx.carPath || '',
      uploadStatus: 'fork-pr-blocked',
    })

    await writeSummary(ctx, 'Fork PR blocked')

    // Comment on PR with the actual IPFS Root CID
    await commentOnPR(ctx)

    console.log('✓ Fork PR blocked - PR comment posted explaining the limitation')
    return
  }

  if (!ctx.ipfsRootCid) {
    throw new Error('No IPFS Root CID found in context. Build phase may have failed.')
  }

  const rootCid = ctx.ipfsRootCid
  console.log(`Root CID from context: ${rootCid}`)

  // Get CAR file path from context
  const carPath = ctx.carPath
  if (!carPath) {
    throw new Error('No CAR file path found in context. Build phase may have failed.')
  }

  // Verify CAR file exists
  try {
    await access(carPath)
  } catch {
    throw new Error(`CAR file not found at ${carPath}`)
  }

  // Initialize Synapse and upload
  if (!walletPrivateKey) {
    throw new Error('walletPrivateKey is required for upload phase')
  }

  /** @type {Partial<UploadResult>} */
  let { pieceCid, pieceId, dataSetId, provider, previewURL, network } = {}
  /** @type {PaymentStatus} */
  let paymentStatus

  if (dryRun) {
    pieceCid = ctx.pieceCid || 'dry-run'
    pieceId = ctx.pieceId || 'dry-run'
    dataSetId = ctx.dataSetId || 'dry-run'
    provider = ctx.provider || {
      id: 'dry-run',
      name: 'Dry Run Mode',
    }
    previewURL = ctx.previewUrl || 'https://example.com/ipfs/dry-run'
    network = ctx.network || 'dry-run'
    paymentStatus = ctx.paymentStatus || {
      depositedAmount: '0',
      currentBalance: '0',
      storageRunway: 'Unknown',
      depositedThisRun: '0',
      network: 'dry-run',
      address: 'dry-run',
      filBalance: 0n,
      usdfcBalance: 0n,
      currentAllowances: {
        rateAllowance: 0n,
        lockupAllowance: 0n,
        lockupUsed: 0n,
      },
    }
  } else {
    const synapse = await initializeSynapse({ walletPrivateKey, network: inputNetwork }, logger)

    paymentStatus = await handlePayments(synapse, { minStorageDays, filecoinPayBalanceLimit }, logger)

    const uploadResult = await uploadCarToFilecoin(synapse, carPath, rootCid, { withCDN, providerAddress }, logger)
    pieceCid = uploadResult.pieceCid
    pieceId = uploadResult.pieceId
    dataSetId = uploadResult.dataSetId
    provider = uploadResult.provider
    previewURL = uploadResult.previewURL
    network = uploadResult.network
  }

  const uploadStatus = dryRun ? 'dry-run' : 'uploaded'

  // Update context
  await mergeAndSaveContext({
    pieceCid,
    pieceId,
    dataSetId,
    provider,
    previewUrl: previewURL,
    network,
    contentPath: contentPath,
    uploadStatus,
    paymentStatus,
    dryRun,
  })

  // Write outputs
  await writeOutputs({
    ipfsRootCid: rootCid,
    dataSetId: dataSetId,
    pieceCid: pieceCid,
    providerId: provider.id || '',
    providerName: provider.name || '',
    carPath: carPath,
    uploadStatus,
  })

  console.log('\n━━━ Upload Complete ━━━')
  console.log(`Network: ${network}`)
  console.log(`IPFS Root CID: ${pc.bold(rootCid)}`)
  console.log(`Data Set ID: ${dataSetId}`)
  console.log(`::notice::Upload complete. IPFS Root CID: ${rootCid}`)
  console.log(`Piece CID: ${pieceCid}`)
  console.log(`Provider: ${provider.name || 'Unknown'} (ID ${provider.id || 'Unknown'})`)
  console.log(`Preview: ${previewURL}`)

  /** @type {Partial<CombinedContext>} */
  ctx = getGlobalContext()
  await writeSummary(ctx, 'Uploaded')

  // Comment on PR
  await commentOnPR(ctx)

  await cleanupSynapse()
}
