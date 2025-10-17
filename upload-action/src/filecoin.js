import { promises as fs } from 'node:fs'
import { RPC_URLS } from '@filoz/synapse-sdk'
import {
  calculateStorageRunway,
  computeAdjustmentForExactDaysWithFile,
  computeTopUpForDuration,
  depositUSDFC,
  getPaymentStatus,
} from 'filecoin-pin/core/payments'
import {
  cleanupSynapseService,
  createStorageContext,
  initializeSynapse as initSynapse,
} from 'filecoin-pin/core/synapse'
import { createUnixfsCarBuilder } from 'filecoin-pin/core/unixfs'
import { checkUploadReadiness, executeUpload, getDownloadURL } from 'filecoin-pin/core/upload'
import { formatRunwaySummary, formatUSDFC } from 'filecoin-pin/core/utils'
import { CID } from 'multiformats/cid'
import { ERROR_CODES, FilecoinPinError, getErrorMessage } from './errors.js'

/**
 * @typedef {import('./types.js').CreateStorageContextOptions} CreateStorageContextOptions
 * @typedef {import('./types.js').ParsedInputs} ParsedInputs
 * @typedef {import('./types.js').BuildResult} BuildResult
 * @typedef {import('./types.js').UploadResult} UploadResult
 * @typedef {import('./types.js').PaymentStatus} PaymentStatus
 * @typedef {import('./types.js').PaymentConfig} PaymentConfig
 * @typedef {import('./types.js').UploadConfig} UploadConfig
 * @typedef {import('./types.js').FilecoinPinPaymentStatus} FilecoinPinPaymentStatus
 * @typedef {import('./types.js').Synapse} Synapse
 */

/**
 * Initialize Synapse sdk with error handling
 * @param {{ walletPrivateKey: string, network: 'mainnet' | 'calibration' }} config - Wallet and network config
 * @param {any} logger - Logger instance
 * @returns {Promise<Synapse>} Synapse service
 */
export async function initializeSynapse(config, logger) {
  try {
    const { walletPrivateKey, network } = config
    if (!network || (network !== 'mainnet' && network !== 'calibration')) {
      throw new FilecoinPinError('Network must be either "mainnet" or "calibration"', ERROR_CODES.INVALID_INPUT)
    }

    const rpcConfig = RPC_URLS[network]
    if (!rpcConfig) {
      throw new FilecoinPinError(`Unsupported network: ${network}`, ERROR_CODES.INVALID_INPUT)
    }

    return await initSynapse(
      {
        privateKey: walletPrivateKey,
        rpcUrl: rpcConfig.websocket,
      },
      logger
    )
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    if (errorMessage.includes('invalid private key')) {
      throw new FilecoinPinError('Invalid private key format', ERROR_CODES.INVALID_PRIVATE_KEY)
    }
    throw new FilecoinPinError(`Failed to initialize Synapse: ${errorMessage}`, ERROR_CODES.NETWORK_ERROR)
  }
}

/**
 * Handle payment setup and top-ups
 * @param {Synapse} synapse - Synapse service
 * @param {PaymentConfig} options - Payment options
 * @param {any} logger - Logger instance
 * @returns {Promise<PaymentStatus>} Updated payment status
 */
export async function handlePayments(synapse, options, logger) {
  const { minStorageDays, filecoinPayBalanceLimit, carSizeBytes } = options

  console.log('Checking current Filecoin Pay account balance...')
  const initialStatus = await getPaymentStatus(synapse)

  console.log(`Current Filecoin Pay balance: ${formatUSDFC(initialStatus.depositedAmount)} USDFC`)
  console.log(`Wallet USDFC balance: ${formatUSDFC(initialStatus.usdfcBalance)} USDFC`)

  let requiredTopUp = 0n

  if (minStorageDays > 0) {
    const rateUsed = initialStatus.currentAllowances.rateUsed ?? 0n

    // If there's an upcoming file upload and no existing usage, calculate deposit based on file size
    if (rateUsed === 0n && carSizeBytes != null && carSizeBytes > 0) {
      // Get pricing information to calculate file requirements
      const storageInfo = await synapse.storage.getStorageInfo()
      const pricePerTiBPerEpoch = storageInfo.pricing.noCDN.perTiBPerEpoch

      // Calculate required deposit accounting for the new file
      const { delta } = computeAdjustmentForExactDaysWithFile(
        initialStatus,
        minStorageDays,
        carSizeBytes,
        pricePerTiBPerEpoch
      )

      requiredTopUp = delta > 0n ? delta : 0n
      console.log(
        `Required top-up for ${minStorageDays} days of storage (including upcoming upload): ${formatUSDFC(requiredTopUp)} USDFC`
      )
    } else {
      // Use existing logic for maintaining current usage
      const { topUp } = computeTopUpForDuration(initialStatus, minStorageDays)
      requiredTopUp = topUp
      console.log(`Required top-up for ${minStorageDays} days of storage: ${formatUSDFC(requiredTopUp)} USDFC`)
    }
  }

  // Check if deposit would exceed maximum balance if specified
  if (filecoinPayBalanceLimit != null && filecoinPayBalanceLimit >= 0n) {
    // Check if current balance already equals or exceeds limit
    if (initialStatus.depositedAmount >= filecoinPayBalanceLimit) {
      logger.warn(
        `⚠️  Current balance (${formatUSDFC(initialStatus.depositedAmount)}) already equals or exceeds filecoinPayBalanceLimit (${formatUSDFC(filecoinPayBalanceLimit)}). No additional deposits will be made.`
      )
      requiredTopUp = 0n // Don't deposit anything
    } else {
      // Check if required top-up would exceed the limit
      const projectedBalance = initialStatus.depositedAmount + requiredTopUp
      if (projectedBalance > filecoinPayBalanceLimit) {
        // Calculate the maximum allowed top-up that won't exceed the limit
        const maxAllowedTopUp = filecoinPayBalanceLimit - initialStatus.depositedAmount
        if (maxAllowedTopUp > 0n) {
          logger.warn(
            `⚠️  Required top-up (${formatUSDFC(requiredTopUp)}) would exceed filecoinPayBalanceLimit (${formatUSDFC(filecoinPayBalanceLimit)}). Reducing to ${formatUSDFC(maxAllowedTopUp)}.`
          )
          requiredTopUp = maxAllowedTopUp
        } else {
          requiredTopUp = 0n
        }
      }
    }
  }

  let newStatus = initialStatus
  if (requiredTopUp > 0n) {
    console.log(`\nSubmitting transaction to deposit ${formatUSDFC(requiredTopUp)} USDFC to Filecoin Pay...`)
    logger.info(`Depositing ${formatUSDFC(requiredTopUp)} USDFC to Filecoin Pay ...`)
    await depositUSDFC(synapse, requiredTopUp)
    console.log('✓ Transaction submitted successfully')
    console.log('(Note: Transaction will continue to process in the background)')

    // Verify the deposit was initiated
    console.log('\nVerifying deposit transaction...')
    newStatus = await getPaymentStatus(synapse)
    const depositDifference = newStatus.depositedAmount - initialStatus.depositedAmount

    if (depositDifference > 0n) {
      console.log(`✓ Deposit verified: ${formatUSDFC(depositDifference)} USDFC added to Filecoin Pay`)
      console.log(`New Filecoin Pay balance: ${formatUSDFC(newStatus.depositedAmount)} USDFC`)
    } else {
      console.log('⚠️  Deposit transaction submitted but not yet reflected in balance')
      console.log('(This is normal - the transaction may take a moment to process)')
    }
  } else {
    console.log('✓ No deposit required - sufficient balance available')
  }

  return {
    ...initialStatus,
    // the amount of USDFC you have deposited to Filecoin Pay
    depositedAmount: formatUSDFC(newStatus.depositedAmount),
    // the amount of USDFC you currently hold in your wallet
    currentBalance: formatUSDFC(newStatus.usdfcBalance),
    // the amount of time you have until your funds would run out based on storage usage
    storageRunway: formatRunwaySummary(calculateStorageRunway(newStatus)),
    // the amount of USDFC deposited to Filecoin Pay during this run
    depositedThisRun: formatUSDFC(requiredTopUp),
  }
}

/**
 * Create CAR file from content path
 * @param {string} targetPath - Path to content
 * @param {string} contentPath - Original content path for logging
 * @param {any} logger - Logger instance
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
    throw new FilecoinPinError(`Failed to create CAR file: ${getErrorMessage(error)}`, ERROR_CODES.CAR_CREATE_FAILED)
  }
}

/**
 * Upload CAR to Filecoin via filecoin-pin
 * @param {any} synapse - Synapse service
 * @param {string} carPath - Path to CAR file
 * @param {string} ipfsRootCid - Root CID
 * @param {UploadConfig} options - Upload options
 * @param {any} logger - Logger instance
 * @returns {Promise<UploadResult>} Upload result
 */
export async function uploadCarToFilecoin(synapse, carPath, ipfsRootCid, options, logger) {
  const { withCDN, providerAddress } = options
  const providerIdInput = options.providerId

  // Read CAR data
  const carBytes = await fs.readFile(carPath)

  // Validate payment capacity through reusable helper
  const readiness = await checkUploadReadiness({
    synapse,
    fileSize: carBytes.length,
    autoConfigureAllowances: true,
  })

  if (!readiness.validation.isValid) {
    throw new FilecoinPinError(
      `Payment setup incomplete: ${readiness.validation.errorMessage}`,
      ERROR_CODES.INSUFFICIENT_FUNDS,
      {
        helpMessage: readiness.validation.helpMessage,
      }
    )
  }

  if (readiness.capacity && !readiness.capacity.canUpload) {
    throw new FilecoinPinError('Insufficient deposit for this upload', ERROR_CODES.INSUFFICIENT_FUNDS, {
      suggestions: readiness.suggestions,
      issues: readiness.capacity.issues,
    })
  }

  if (readiness.allowances.updated) {
    logger.info(
      {
        event: 'payments.allowances.updated',
        transactionHash: readiness.allowances.transactionHash,
      },
      'WarmStorage permissions configured automatically'
    )
  } else if (readiness.allowances.needsUpdate) {
    logger.warn({ event: 'payments.allowances.pending' }, 'WarmStorage permissions require manual configuration')
  }

  if (readiness.suggestions.length > 0) {
    logger.warn(
      {
        event: 'payments.capacity.warning',
        suggestions: readiness.suggestions,
      },
      'Payment capacity verified with warnings'
    )
  }

  // Prepare storage context options (inputs.js already handled priority logic)
  /** @type {CreateStorageContextOptions} */
  const storageOptions = {}

  if (providerAddress) {
    storageOptions.providerAddress = providerAddress
    logger.info({ event: 'upload.provider_override', providerAddress }, 'Using provider address override')
  } else if (providerIdInput != null) {
    storageOptions.providerId = providerIdInput
    logger.info({ event: 'upload.provider_override', providerIdInput }, 'Using provider ID override')
  }

  // Create storage context with optional CDN flag
  if (withCDN) process.env.WITH_CDN = 'true'
  const { storage, providerInfo } = await createStorageContext(synapse, logger, storageOptions)

  // Upload to Filecoin via filecoin-pin with progress tracking
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

  const providerId = String(providerInfo.id ?? '')
  const providerName = providerInfo.name ?? (providerInfo.serviceProvider || '')
  const previewUrl = getDownloadURL(providerInfo, uploadResult.pieceCid) || `https://dweb.link/ipfs/${ipfsRootCid}`

  return {
    pieceCid: uploadResult.pieceCid,
    pieceId: uploadResult.pieceId != null ? String(uploadResult.pieceId) : '',
    dataSetId: uploadResult.dataSetId,
    provider: { id: providerId, name: providerName, address: providerInfo.serviceProvider ?? '' },
    previewUrl,
    network: uploadResult.network,
  }
}

/**
 * Cleanup filecoin-pin service
 * @returns {Promise<void>}
 */
export async function cleanupSynapse() {
  try {
    await cleanupSynapseService()
  } catch (error) {
    console.error('Cleanup failed:', getErrorMessage(error))
  }
}
