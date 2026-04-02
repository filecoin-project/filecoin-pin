import { promises as fs } from 'node:fs'
import {
  calculateStorageRunway,
  checkAndSetAllowances,
  executeTopUp,
  getPaymentStatus,
} from 'filecoin-pin/core/payments'
import { createUnixfsCarBuilder } from 'filecoin-pin/core/unixfs'
import { executeUpload } from 'filecoin-pin/core/upload'
import { formatRunwaySummary, formatUSDFC } from 'filecoin-pin/core/utils'
import { CID } from 'multiformats/cid'
import { getErrorMessage } from './errors.js'

const EPOCHS_PER_DAY = 2880n

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
 * Handle payment setup and top-ups using core payment functions
 * @param {Synapse} synapse - Synapse service
 * @param {PaymentFundingConfig} options - Payment options
 * @param {Logger | undefined} logger - Logger instance
 * @returns {Promise<SimplifiedPaymentStatus>} Updated payment status
 */
export async function handlePayments(synapse, options, logger) {
  const { minStorageDays, filecoinPayBalanceLimit, pieceSizeBytes, withCDN, providerIds } = options

  if (pieceSizeBytes == null) {
    throw new Error('pieceSizeBytes is required for payment calculation')
  }

  console.log('Checking current Filecoin Pay account balance...')
  const rawStatus = await getPaymentStatus(synapse)

  const initialFilecoinPayBalance = formatUSDFC(rawStatus.filecoinPayBalance)
  const initialWalletBalance = formatUSDFC(rawStatus.walletUsdfcBalance)

  console.log(`Current Filecoin Pay balance: ${initialFilecoinPayBalance} USDFC`)
  console.log(`Wallet USDFC balance: ${initialWalletBalance} USDFC`)

  const contexts = await synapse.storage.createContexts({
    ...(providerIds != null && providerIds.length > 0 ? { providerIds } : {}),
    ...(withCDN ? { withCDN } : {}),
  })
  const resolvedRunwayDays = Math.floor(minStorageDays)
  const uploadCosts = await synapse.storage.calculateMultiContextCosts(contexts, {
    dataSize: BigInt(pieceSizeBytes),
    extraRunwayEpochs: BigInt(resolvedRunwayDays) * EPOCHS_PER_DAY,
  })

  const newDataSetCount = contexts.filter((context) => context.dataSetId == null).length

  if (uploadCosts.depositNeeded > 0n) {
    console.log(`\nRequired funding from SDK upload-cost calculation: ${formatUSDFC(uploadCosts.depositNeeded)} USDFC`)
    console.log(
      `Contexts: ${contexts.length} copy${contexts.length === 1 ? '' : 'ies'}, ` +
        `${newDataSetCount} new data set${newDataSetCount === 1 ? '' : 's'}, ` +
        `${resolvedRunwayDays} runway day${resolvedRunwayDays === 1 ? '' : 's'}`
    )
  }

  // Execute top-up with balance limit checking
  const topUpResult = await executeTopUp(synapse, uploadCosts.depositNeeded, {
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

  if (uploadCosts.depositNeeded === 0n && uploadCosts.needsFwssMaxApproval) {
    console.log('\nSubmitting transaction to approve Warm Storage spending allowances...')
    const allowanceResult = await checkAndSetAllowances(synapse)
    if (allowanceResult.updated) {
      console.log('✓ Warm Storage allowances updated')
      console.log(`Transaction hash: ${allowanceResult.transactionHash}`)
    }
  }

  let finalStatus = rawStatus
  if (topUpResult.success && (topUpResult.deposited > 0n || uploadCosts.needsFwssMaxApproval)) {
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
