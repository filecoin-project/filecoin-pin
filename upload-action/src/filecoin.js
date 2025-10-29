import { promises as fs } from 'node:fs'
import { Wallet } from 'ethers'
import {
  calculateRequiredTopUp,
  calculateStorageRunway,
  executeTopUp,
  getPaymentStatus,
} from 'filecoin-pin/core/payments'
import { cleanupSynapseService, createStorageContext, initializeSynapseWithSigner } from 'filecoin-pin/core/synapse'
import { createUnixfsCarBuilder } from 'filecoin-pin/core/unixfs'
import { executeUpload, getDownloadURL } from 'filecoin-pin/core/upload'
import { formatRunwaySummary, formatUSDFC } from 'filecoin-pin/core/utils'
import { CID } from 'multiformats/cid'
import { getErrorMessage } from './errors.js'

/**
 * @typedef {import('./types.js').CreateStorageContextOptions} CreateStorageContextOptions
 * @typedef {import('./types.js').ParsedInputs} ParsedInputs
 * @typedef {import('./types.js').BuildResult} BuildResult
 * @typedef {import('./types.js').UploadResult} UploadResult
 * @typedef {import('./types.js').PaymentStatus} PaymentStatus
 * @typedef {import('./types.js').SimplifiedPaymentStatus} SimplifiedPaymentStatus
 * @typedef {import('./types.js').PaymentConfig} PaymentConfig
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
 * @param {PaymentConfig} options - Payment options
 * @param {Logger | undefined} logger - Logger instance
 * @returns {Promise<SimplifiedPaymentStatus>} Updated payment status
 */
export async function handlePayments(synapse, options, logger) {
  const { minStorageDays, filecoinPayBalanceLimit, carSizeBytes } = options

  console.log('Checking current Filecoin Pay account balance...')
  const [rawStatus, storageInfo] = await Promise.all([getPaymentStatus(synapse), synapse.storage.getStorageInfo()])

  const initialFilecoinPayBalance = formatUSDFC(rawStatus.filecoinPayBalance)
  const initialWalletBalance = formatUSDFC(rawStatus.walletUsdfcBalance)

  console.log(`Current Filecoin Pay balance: ${initialFilecoinPayBalance} USDFC`)
  console.log(`Wallet USDFC balance: ${initialWalletBalance} USDFC`)

  // Calculate required top-up with pricing info
  const topUpCalculation = calculateRequiredTopUp(rawStatus, {
    minStorageDays,
    carSizeBytes,
    pricePerTiBPerEpoch: storageInfo.pricing.noCDN.perTiBPerEpoch,
  })

  if (topUpCalculation.requiredTopUp > 0n) {
    console.log(`\n${topUpCalculation.reason}: ${topUpCalculation.requiredTopUp} USDFC`)
  }

  // Execute top-up with balance limit checking
  const topUpResult = await executeTopUp(synapse, topUpCalculation.requiredTopUp, {
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
 * @param {Synapse} synapse - Synapse service
 * @param {string} carPath - Path to CAR file
 * @param {string} ipfsRootCid - Root CID
 * @param {UploadConfig} options - Upload options
 * @param {any} logger - Logger instance
 * @returns {Promise<UploadResult>} Upload result
 */
export async function uploadCarToFilecoin(synapse, carPath, ipfsRootCid, options, logger) {
  const { withCDN, providerAddress, providerId } = options

  // Read CAR data
  const carBytes = await fs.readFile(carPath)

  // Create storage context with provider selection
  /** @type {CreateStorageContextOptions} */
  const storageOptions = {}
  if (providerAddress) {
    storageOptions.providerAddress = providerAddress
    logger.info({ event: 'upload.provider_override', providerAddress }, 'Using provider address override')
  } else if (providerId != null) {
    storageOptions.providerId = providerId
    logger.info({ event: 'upload.provider_override', providerId }, 'Using provider ID override')
  }

  // Set CDN flag if requested
  if (withCDN) process.env.WITH_CDN = 'true'

  const { storage, providerInfo } = await createStorageContext(synapse, logger, storageOptions)

  // Upload to Filecoin via core upload function
  const synapseService = { synapse, storage, providerInfo }
  const cid = CID.parse(ipfsRootCid)

  console.log('\nStarting upload to storage provider...')
  console.log('⏳ Uploading data to PDP server...')

  const uploadResult = await executeUpload(synapseService, carBytes, cid, {
    logger,
    contextId: `gha-upload-${Date.now()}`,
    callbacks: {
      onUploadComplete: (pieceCid) => {
        console.log('✓ Data uploaded to PDP server successfully')
        console.log(`Piece CID: ${pieceCid}`)
        console.log('\n⏳ Registering piece in data set...')
      },
      onPieceAdded: (transaction) => {
        if (transaction?.hash) {
          console.log('✓ Piece registration transaction submitted')
          console.log(`Transaction hash: ${transaction.hash}`)
          console.log('\n⏳ Waiting for on-chain confirmation...')
        } else {
          console.log('✓ Piece added to data set (no transaction needed)')
        }
      },
      onPieceConfirmed: (pieceIds) => {
        console.log('✓ Piece confirmed on-chain')
        console.log(`Piece ID(s): ${pieceIds.join(', ')}`)
      },
    },
  })

  console.log('\n✓ Upload to Filecoin complete!')

  const providerIdStr = String(providerInfo.id ?? '')
  const providerName = providerInfo.name ?? (providerInfo.serviceProvider || '')
  const previewUrl = getDownloadURL(providerInfo, uploadResult.pieceCid) || `https://dweb.link/ipfs/${ipfsRootCid}`

  return {
    pieceCid: uploadResult.pieceCid,
    pieceId: uploadResult.pieceId != null ? String(uploadResult.pieceId) : '',
    dataSetId: uploadResult.dataSetId,
    provider: { id: providerIdStr, name: providerName, address: providerInfo.serviceProvider ?? '' },
    previewUrl,
    network: uploadResult.network,
  }
}

/**
 * Initialize Synapse with wallet private key using core functionality
 * @param {{ walletPrivateKey: string, network: 'mainnet' | 'calibration' }} config - Wallet and network config
 * @param {Logger} logger - Logger instance
 * @returns {Promise<Synapse>} Synapse service
 */
export async function initializeSynapse(config, logger) {
  try {
    const { walletPrivateKey, network } = config
    if (!network || (network !== 'mainnet' && network !== 'calibration')) {
      throw new Error('Network must be either "mainnet" or "calibration"')
    }

    // Create signer from private key
    const signer = new Wallet(walletPrivateKey)

    // Initialize Synapse using core function
    return await initializeSynapseWithSigner(signer, network, logger)
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    if (errorMessage.includes('invalid private key')) {
      throw new Error('Invalid private key format')
    }
    throw new Error(`Failed to initialize Synapse: ${errorMessage}`)
  }
}

/**
 * Cleanup filecoin-pin service using core functionality
 * @returns {Promise<void>}
 */
export async function cleanupSynapse() {
  try {
    await cleanupSynapseService()
  } catch (error) {
    console.error('Cleanup failed:', getErrorMessage(error))
  }
}
