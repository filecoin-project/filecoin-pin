import { createReadStream, promises as fs } from 'node:fs'
import { CarReader } from '@ipld/car'
import {
  calculateFilecoinPayFundingPlan,
  calculateStorageRunway,
  executeTopUp,
  formatFundingReason,
  getPaymentStatus,
} from 'filecoin-pin/core/payments'
import { createUnixfsCarBuilder } from 'filecoin-pin/core/unixfs'
import { executeUpload } from 'filecoin-pin/core/upload'
import { formatRunwaySummary, formatUSDFC } from 'filecoin-pin/core/utils'
import { CID } from 'multiformats/cid'
import { getErrorMessage } from './errors.js'

const USDFC_SYBIL_FEE = 100_000_000_000_000_000n

/**
 * @typedef {import('./types.js').ParsedInputs} ParsedInputs
 * @typedef {import('./types.js').BuildResult} BuildResult
 * @typedef {import('./types.js').UploadResult} UploadResult
 * @typedef {import('./types.js').PaymentStatus} PaymentStatus
 * @typedef {import('./types.js').SimplifiedPaymentStatus} SimplifiedPaymentStatus
 * @typedef {import('./types.js').PaymentFundingConfig} PaymentFundingConfig
 * @typedef {import('./types.js').UploadConfig} UploadConfig
 * @typedef {import('./types.js').FilecoinPinPaymentStatus} FilecoinPinPaymentStatus
 * @typedef {import('./types.js').Synapse} Synapse
 * @typedef {import('./types.js').Logger} Logger
 */

/**
 * Create CAR file from content path using core unixfs functionality
 * @param {string} targetPath - Path to content
 * @param {string} contentPath - Original content path for logging
 * @param {Logger} logger - Logger instance
 * @returns {Promise<BuildResult>} CAR file info
 */
export async function createCarFile(targetPath, contentPath, logger) {
  try {
    const builder = createUnixfsCarBuilder()
    logger.info(`Packing '${contentPath}' into CAR (UnixFS) ...`)

    const { carPath, rootCid, size } = await builder.buildCar(targetPath, {
      logger,
    })

    return { carPath, ipfsRootCid: rootCid, contentPath, carSize: size }
  } catch (error) {
    throw new Error(`Failed to create CAR file: ${getErrorMessage(error)}`)
  }
}

/**
 * Read a pre-built CAR file and extract its single root CID.
 *
 * Only the CAR header is parsed, so this is cheap even for large CARs.
 * The CAR must declare exactly one root; multi-root and rootless CARs
 * are rejected so the upload flow always has an unambiguous IPFS root CID.
 *
 * @param {string} targetPath - Absolute path to the CAR file
 * @param {string} contentPath - Original input path for logging
 * @param {Logger} logger - Logger instance
 * @returns {Promise<BuildResult>} CAR file info
 */
export async function readCarFile(targetPath, contentPath, logger) {
  try {
    logger.info(`Using pre-built CAR at '${contentPath}' ...`)

    const [{ size }, roots] = await Promise.all([fs.stat(targetPath), readCarRoots(targetPath)])

    const [rootCid, ...extraRoots] = roots
    if (!rootCid) {
      throw new Error('CAR file declares no roots; a single-root CAR is required')
    }
    if (extraRoots.length > 0) {
      throw new Error(`CAR file declares ${roots.length} roots; a single-root CAR is required`)
    }

    return { carPath: targetPath, ipfsRootCid: rootCid.toString(), contentPath, carSize: size }
  } catch (error) {
    throw new Error(`Failed to read CAR file: ${getErrorMessage(error)}`)
  }
}

/**
 * Stream-parse a CAR header and return its declared roots.
 * @param {string} filePath
 * @returns {Promise<CID[]>}
 */
async function readCarRoots(filePath) {
  const stream = createReadStream(filePath)
  try {
    const reader = await CarReader.fromIterable(/** @type {any} */ (stream))
    return await reader.getRoots()
  } finally {
    stream.destroy()
  }
}

/**
 * Handle payment setup and top-ups using core payment functions
 * @param {Synapse} synapse - Synapse service
 * @param {PaymentFundingConfig} options - Payment options
 * @param {Logger | undefined} logger - Logger instance
 * @returns {Promise<SimplifiedPaymentStatus>} Updated payment status
 */
export async function handlePayments(synapse, options, logger) {
  const { minStorageDays, filecoinPayBalanceLimit, pieceSizeBytes, withCDN, providerIds } = options

  console.log('Checking current Filecoin Pay account balance...')
  const [rawStatus, storageInfo, contexts] = await Promise.all([
    getPaymentStatus(synapse),
    synapse.storage.getStorageInfo(),
    synapse.storage.createContexts({
      ...(providerIds != null && providerIds.length > 0 ? { providerIds } : {}),
      ...(withCDN ? { withCDN } : {}),
    }),
  ])

  const initialFilecoinPayBalance = formatUSDFC(rawStatus.filecoinPayBalance)
  const initialWalletBalance = formatUSDFC(rawStatus.walletUsdfcBalance)

  console.log(`Current Filecoin Pay balance: ${initialFilecoinPayBalance} USDFC`)
  console.log(`Wallet USDFC balance: ${initialWalletBalance} USDFC`)

  // Calculate required funding using the comprehensive funding planner
  const fundingPlan = calculateFilecoinPayFundingPlan({
    status: rawStatus,
    mode: 'minimum', // Only deposit if below minimum
    allowWithdraw: false, // Never withdraw in upload-action
    targetRunwayDays: minStorageDays,
    pieceSizeBytes,
    pricePerTiBPerEpoch: storageInfo.pricing.noCDN.perTiBPerEpoch,
  })

  if (fundingPlan.delta > 0n) {
    const reasonMessage = formatFundingReason(fundingPlan.reasonCode, fundingPlan)
    console.log(`\n${reasonMessage}: ${formatUSDFC(fundingPlan.delta)} USDFC`)
  }

  const newDataSetCount = contexts.filter((context) => context.dataSetId == null).length
  const sybilFeeTopUp = BigInt(newDataSetCount) * USDFC_SYBIL_FEE

  if (sybilFeeTopUp > 0n) {
    console.log(
      `Additional funding for ${newDataSetCount} new data set${newDataSetCount === 1 ? '' : 's'} ` +
        `(sybil fee): ${formatUSDFC(sybilFeeTopUp)} USDFC`
    )
  }

  const totalTopUp = fundingPlan.delta + sybilFeeTopUp

  // Execute top-up with balance limit checking
  const topUpResult = await executeTopUp(synapse, totalTopUp, {
    balanceLimit: filecoinPayBalanceLimit,
    logger,
  })

  if (topUpResult.success && topUpResult.deposited > 0n) {
    console.log(`\nSubmitting transaction to deposit ${topUpResult.deposited} USDFC to Filecoin Pay...`)
    console.log('✓ Transaction submitted successfully')
    console.log('(Note: Transaction will continue to process in the background)')
  } else if (topUpResult.success) {
    console.log('✓ No deposit required - sufficient balance available')
  } else {
    throw new Error(`Payment setup failed: ${topUpResult.message}`)
  }

  let finalStatus = rawStatus
  if (topUpResult.success && topUpResult.deposited > 0n) {
    finalStatus = await getPaymentStatus(synapse)
  }

  const filecoinPayBalance = formatUSDFC(finalStatus.filecoinPayBalance)
  const walletUsdfcBalance = formatUSDFC(finalStatus.walletUsdfcBalance)

  // Return formatted status for action consumption
  return {
    filecoinPayBalance,
    walletUsdfcBalance,
    storageRunway: formatRunwaySummary(calculateStorageRunway(finalStatus)),
    depositedThisRun: topUpResult.deposited.toString(),
  }
}

/**
 * Upload CAR to Filecoin using core upload functionality
 * @param {Synapse} synapse - Synapse instance
 * @param {string} carPath - Path to CAR file
 * @param {string} ipfsRootCid - Root CID
 * @param {UploadConfig} options - Upload options
 * @param {any} logger - Logger instance
 * @returns {Promise<UploadResult>} Upload result
 */
export async function uploadCarToFilecoin(synapse, carPath, ipfsRootCid, options, logger) {
  const carBytes = await fs.readFile(carPath)
  const cid = CID.parse(ipfsRootCid)

  /** @type {bigint[] | undefined} */
  const providerIds = options.providerIds != null && options.providerIds.length > 0 ? options.providerIds : undefined
  if (providerIds) {
    logger.info(
      { event: 'upload.provider_override', providerIds: providerIds.map(String) },
      'Using provider ID override'
    )
  }

  console.log('\nStarting upload to storage provider...')
  console.log('Uploading data to PDP server...')

  const uploadResult = await executeUpload(synapse, carBytes, cid, {
    logger,
    contextId: `gha-upload-${Date.now()}`,
    ...(providerIds != null && { providerIds }),
    onProgress: (event) => {
      switch (event.type) {
        case 'onStored': {
          console.log(`✓ Data stored on provider ${event.data.providerId}`)
          console.log(`Piece CID: ${event.data.pieceCid}`)
          break
        }
        case 'onPiecesAdded': {
          if (event.data.txHash) {
            console.log('✓ Piece registration transaction submitted')
            console.log(`Transaction hash: ${event.data.txHash}`)
          }
          break
        }
        case 'onPiecesConfirmed': {
          console.log(`✓ Piece confirmed on-chain (data set ${event.data.dataSetId})`)
          break
        }
        case 'onCopyComplete': {
          console.log(`✓ Secondary copy complete on provider ${event.data.providerId}`)
          break
        }
        case 'onCopyFailed': {
          console.log(
            `Warning: Secondary copy failed on provider ${event.data.providerId}: ${event.data.error.message}`
          )
          break
        }
        case 'ipniProviderResults.retryUpdate': {
          const attempt = event.data.attempt ?? (event.data.retryCount === 0 ? 1 : event.data.retryCount + 1)
          console.log(`IPNI provider results check attempt #${attempt}...`)
          break
        }
        case 'ipniProviderResults.complete': {
          console.log(event.data.result ? '✓ IPNI provider results found' : 'IPNI provider results not found')
          break
        }
        case 'ipniProviderResults.failed': {
          console.log('IPNI provider results not found')
          console.log(`Error: ${event.data.error.message}`)
          break
        }
        default: {
          break
        }
      }
    },
  })

  console.log('\n✓ Upload to Filecoin complete!')

  // Extract primary copy details for backwards-compatible output
  const primaryCopy = uploadResult.copies.find((c) => c.role === 'primary')

  if (primaryCopy == null) {
    const failureCount = uploadResult.failedAttempts.length
    throw new Error(
      failureCount > 0
        ? `Upload failed: all ${failureCount} copy attempt(s) failed`
        : 'Upload failed: no copies were created'
    )
  }

  return {
    pieceCid: uploadResult.pieceCid,
    pieceId: String(primaryCopy.pieceId),
    dataSetId: String(primaryCopy.dataSetId),
    provider: {
      id: String(primaryCopy.providerId),
      name: '',
    },
    previewUrl: primaryCopy.retrievalUrl ?? '',
    network: uploadResult.network,
    ipniValidated: uploadResult.ipniValidated,
    copies: uploadResult.copies,
    failedAttempts: uploadResult.failedAttempts,
  }
}
