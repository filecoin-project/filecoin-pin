import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pc from 'picocolors'
import pino from 'pino'
import { createArtifacts, mirrorToStandardCache, readCachedMetadata, writeCachedMetadata } from './cache.js'
import { handleError } from './errors.js'
import { cleanupSynapse, createCarFile, handlePayments, initializeSynapse, uploadCarToFilecoin } from './filecoin.js'
// Import our organized modules
import { parseInputs, resolveContentPath } from './inputs.js'
import { writeOutputs, writeSummary } from './outputs.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function main() {
  const phase = process.env.ACTION_PHASE || 'single'
  const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

  // Parse and validate inputs
  const inputs = parseInputs()
  const { privateKey, contentPath, minDays, minBalance, maxTopUp, withCDN, token, providerAddress } = inputs

  // Resolve content path (relative to workspace)
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd()
  const targetPath = resolveContentPath(contentPath)

  // PHASE: compute -> pack only, set outputs and exit
  if (phase === 'compute') {
    const { carPath, rootCid } = await createCarFile(targetPath, contentPath, logger)
    await writeOutputs({
      root_cid: rootCid,
      car_path: carPath,
    })
    return
  }

  // PHASE: from-cache -> read cached metadata and set outputs + summary
  if (phase === 'from-cache') {
    const fromArtifact = String(process.env.FROM_ARTIFACT || '').toLowerCase() === 'true'
    const cacheDir = process.env.CACHE_DIR
    const meta = await readCachedMetadata(cacheDir)

    await writeOutputs({
      root_cid: meta.rootCid,
      data_set_id: meta.dataSetId,
      piece_cid: meta.pieceCid,
      provider_id: meta.provider?.id || '',
      provider_name: meta.provider?.name || '',
      car_path: meta.carPath,
      metadata_path: join(cacheDir, 'upload.json'),
      upload_status: fromArtifact ? 'reused-artifact' : 'reused-cache',
    })

    // Log reuse status for easy scanning
    console.log(fromArtifact ? 'Reused previous artifact (no new upload)' : 'Reused cached metadata (no new upload)')

    // Ensure balances/allowances are still correct even when skipping upload
    try {
      const synapse = await initializeSynapse(privateKey, logger)
      await handlePayments(synapse, { minDays, minBalance, maxTopUp }, logger)
    } catch (error) {
      console.warn('Balance/allowance validation on cache path failed:', error?.message || error)
    } finally {
      await cleanupSynapse()
    }

    // Mirror the restored metadata into the standard cache location
    const metadataText = JSON.stringify(meta, null, 2)
    await mirrorToStandardCache(workspace, meta.rootCid, metadataText)

    // Summary
    const status = fromArtifact ? 'Reused artifact' : 'Reused cache'
    await writeSummary(meta, status)

    return
  }

  // PHASE: upload (or default single-phase)
  const preparedCarPath = process.env.PREPARED_CAR_PATH
  const preparedRootCid = process.env.PREPARED_ROOT_CID

  // Initialize Synapse service
  const synapse = await initializeSynapse(privateKey, logger)

  // Handle payments and top-ups
  await handlePayments(synapse, { minDays, minBalance, maxTopUp }, logger)

  // Prepare CAR and root
  let carPath = preparedCarPath
  let rootCidStr = preparedRootCid
  if (!carPath || !rootCidStr) {
    const { carPath: cPath, rootCid } = await createCarFile(targetPath, contentPath, logger)
    carPath = cPath
    rootCidStr = rootCid
  }

  // Upload to Filecoin
  const uploadResult = await uploadCarToFilecoin(synapse, carPath, rootCidStr, { withCDN, providerAddress }, logger)
  const { pieceCid, pieceId, dataSetId, provider, previewURL, network } = uploadResult

  // Create artifacts and metadata
  const metadata = {
    network,
    contentPath: targetPath,
    rootCid: rootCidStr,
    pieceCid,
    pieceId,
    dataSetId,
    provider,
    previewURL,
  }

  const { artifactCarPath, metadataPath } = await createArtifacts(workspace, carPath, metadata)

  // Write metadata into the cache directory for future reuse
  const cacheDir = join(workspace, '.filecoin-pin-cache', rootCidStr)
  await writeCachedMetadata(cacheDir, { ...metadata, carPath: artifactCarPath })

  // Set action outputs
  await writeOutputs({
    root_cid: rootCidStr,
    data_set_id: dataSetId,
    piece_cid: pieceCid,
    provider_id: provider.id,
    provider_name: provider.name,
    car_path: artifactCarPath,
    metadata_path: metadataPath,
    upload_status: 'uploaded',
  })

  console.log('\n━━━ Filecoin Pin Upload Complete ━━━')
  console.log(`Network: ${network}`)
  console.log(`IPFS Root CID: ${pc.bold(rootCidStr)}`)
  console.log(`Data Set ID: ${dataSetId}`)
  console.log(`Piece CID: ${pieceCid}`)
  console.log(`Provider: ${provider.name} (ID ${provider.id})`)
  console.log(`Preview: ${previewURL}`)
  console.log('Status: New upload performed')

  // Write summary
  await writeSummary({ ...metadata, carPath: artifactCarPath, metadataPath }, 'Uploaded')

  await cleanupSynapse()
}

main().catch(async (err) => {
  handleError(err, { phase: process.env.ACTION_PHASE || 'single' })
  try {
    await cleanupSynapse()
  } catch (e) {
    console.error('Cleanup failed:', e?.message || e)
  }
  process.exit(1)
})
