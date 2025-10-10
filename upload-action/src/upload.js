import { access } from 'node:fs/promises'
import pc from 'picocolors'
import pino from 'pino'
import { commentOnPR } from './comments/comment.js'
import { cleanupSynapse, handlePayments, initializeSynapse, uploadCarToFilecoin } from './filecoin.js'
import { ensurePullRequestContext, updateCheck } from './github.js'
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
 * @param {Partial<CombinedContext>} [buildContext]
 */
export async function runUpload(buildContext = {}) {
  const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

  console.log('━━━ Preparing for Upload ━━━')

  await updateCheck({
    title: 'Initializing upload workflow',
    summary: 'Preparing to upload to Filecoin...',
  })

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

  /** @type {Partial<CombinedContext>} */
  const context = { ...buildContext, contentPath }

  context.dryRun = dryRun

  const resolvedPr = await ensurePullRequestContext(context.pr)
  if (resolvedPr) {
    context.pr = resolvedPr
  }

  console.log('[context-debug] Loaded context from build phase:', context)

  // Check if this was a fork PR that was blocked
  if (context.uploadStatus === 'fork-pr-blocked') {
    console.log('━━━ Fork PR Upload Blocked ━━━')
    console.log('::notice::Fork PR detected - content built but not uploaded to Filecoin, will comment on PR')

    const rootCid = context.ipfsRootCid || ''

    await updateCheck({
      title: 'Fork PR detected',
      summary: 'Fork PR support is currently disabled for security reasons',
      text: 'CAR file built successfully but upload blocked. See PR comment for details.',
    })

    // Write outputs indicating fork PR was blocked
    await writeOutputs({
      ipfsRootCid: rootCid,
      dataSetId: '',
      pieceCid: '',
      providerId: '',
      providerName: '',
      carPath: context.carPath || '',
      uploadStatus: 'fork-pr-blocked',
    })

    await writeSummary(context, 'Fork PR blocked')

    // Comment on PR with the actual IPFS Root CID
    await commentOnPR({ ...context, uploadStatus: 'fork-pr-blocked' })

    console.log('✓ Fork PR blocked - PR comment posted explaining the limitation')
    return context
  }

  if (!context.ipfsRootCid) {
    throw new Error('No IPFS Root CID found in context. Build phase may have failed.')
  }

  const rootCid = context.ipfsRootCid
  console.log(`Root CID from context: ${rootCid}`)

  // Get CAR file path from context
  const carPath = context.carPath
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
  let { pieceCid, pieceId, dataSetId, provider, previewUrl, network } = {}
  /** @type {PaymentStatus} */
  let paymentStatus

  if (dryRun) {
    pieceCid = context.pieceCid || 'dry-run'
    pieceId = context.pieceId || 'dry-run'
    dataSetId = context.dataSetId || 'dry-run'
    provider = context.provider || {
      id: 'dry-run',
      name: 'Dry Run Mode',
    }
    previewUrl = context.previewUrl || 'https://example.com/ipfs/dry-run'
    network = context.network || 'dry-run'
    paymentStatus = context.paymentStatus || {
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

    console.log('\n━━━ Funding Phase: Checking Filecoin Pay Account ━━━')

    await updateCheck({
      title: 'Checking Filecoin Pay balance',
      summary: 'Verifying account balance and calculating required deposits...',
    })

    paymentStatus = await handlePayments(synapse, { minStorageDays, filecoinPayBalanceLimit }, logger)

    console.log('✓ Funding phase complete')

    console.log('\n━━━ Upload Phase: Uploading to Filecoin ━━━')

    await updateCheck({
      title: 'Uploading to storage provider',
      summary: `Uploading CAR file to Filecoin storage provider...`,
    })

    const uploadResult = await uploadCarToFilecoin(synapse, carPath, rootCid, { withCDN, providerAddress }, logger)
    pieceCid = uploadResult.pieceCid
    pieceId = uploadResult.pieceId
    dataSetId = uploadResult.dataSetId
    provider = uploadResult.provider
    previewUrl = uploadResult.previewUrl
    network = uploadResult.network
  }

  const uploadStatus = dryRun ? 'dry-run' : 'uploaded'

  const providerInfo = provider || { id: '', name: '' }

  Object.assign(context, {
    pieceCid,
    pieceId,
    dataSetId,
    provider: providerInfo,
    previewUrl,
    network: network || inputNetwork,
    uploadStatus,
    paymentStatus,
    dryRun,
  })

  provider = providerInfo

  // Write outputs
  await writeOutputs({
    ipfsRootCid: rootCid,
    dataSetId: dataSetId,
    pieceCid: pieceCid,
    providerId: providerInfo.id || '',
    providerName: providerInfo.name || '',
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
  console.log(`Preview: ${previewUrl}`)

  await updateCheck({
    title: 'Finalizing upload',
    summary: `Upload complete. IPFS Root CID: \`${rootCid}\``,
  })

  await writeSummary(context, 'Uploaded')

  // Comment on PR
  await commentOnPR(context)

  await cleanupSynapse()

  return context
}
