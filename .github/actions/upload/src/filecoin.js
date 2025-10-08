import { promises as fs } from 'node:fs'
import { RPC_URLS } from '@filoz/synapse-sdk'
import { createUnixfsCarBuilder } from 'filecoin-pin/core/files'
import {
  calculateStorageRunway,
  computeTopUpForDuration,
  depositUSDFC,
  getPaymentStatus,
} from 'filecoin-pin/core/payments'
import {
  cleanupSynapseService,
  createStorageContext,
  initializeSynapse as initSynapse,
} from 'filecoin-pin/core/synapse'
import { checkUploadReadiness, executeUpload, getDownloadURL } from 'filecoin-pin/core/upload'
import { formatRunwaySummary, formatUSDFC } from 'filecoin-pin/core/utils'
import { CID } from 'multiformats/cid'
import { ERROR_CODES, FilecoinPinError, getErrorMessage } from './errors.js'

/**
 * @typedef {import('./types.js').ParsedInputs} ParsedInputs
 * @typedef {import('./types.js').BuildResult} BuildResult
 * @typedef {import('./types.js').UploadResult} UploadResult
 * @typedef {import('./types.js').PaymentStatus} PaymentStatus
 * @typedef {import('./types.js').FilecoinPinPaymentStatus} FilecoinPinPaymentStatus
 * @typedef {import('@filoz/synapse-sdk').Synapse} Synapse
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
 * @param {{ minStorageDays: number, filecoinPayBalanceLimit?: bigint | undefined }} options - Payment options
 * @param {any} logger - Logger instance
 * @returns {Promise<PaymentStatus>} Updated payment status
 */
export async function handlePayments(synapse, options, logger) {
  const { minStorageDays, filecoinPayBalanceLimit } = options

  const initialStatus = await getPaymentStatus(synapse)
  let requiredTopUp = 0n

  if (minStorageDays > 0) {
    const { topUp } = computeTopUpForDuration(initialStatus, minStorageDays)
    requiredTopUp = topUp
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
    logger.info(`Depositing ${formatUSDFC(requiredTopUp)} USDFC to Filecoin Pay ...`)
    await depositUSDFC(synapse, requiredTopUp)
    newStatus = await getPaymentStatus(synapse)
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
 * @param {{ withCDN: boolean, providerAddress: string }} options - Upload options
 * @param {any} logger - Logger instance
 * @returns {Promise<UploadResult>} Upload result
 */
export async function uploadCarToFilecoin(synapse, carPath, ipfsRootCid, options, logger) {
  const { withCDN, providerAddress } = options

  // Set provider address if specified
  if (providerAddress) {
    process.env.PROVIDER_ADDRESS = providerAddress
  }

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

  // Create storage context with optional CDN flag
  if (withCDN) process.env.WITH_CDN = 'true'
  const { storage, providerInfo } = await createStorageContext(synapse, logger, {})

  // Upload to Filecoin via filecoin-pin
  const synapseService = { synapse, storage, providerInfo }
  const cid = CID.parse(ipfsRootCid)
  const uploadResult = await executeUpload(synapseService, carBytes, cid, {
    logger,
    contextId: `gha-upload-${Date.now()}`,
  })

  const providerId = String(providerInfo.id ?? '')
  const providerName = providerInfo.name ?? (providerInfo.serviceProvider || '')
  const previewURL = getDownloadURL(providerInfo, uploadResult.pieceCid) || `https://ipfs.io/ipfs/${ipfsRootCid}`

  return {
    pieceCid: uploadResult.pieceCid,
    pieceId: uploadResult.pieceId != null ? String(uploadResult.pieceId) : '',
    dataSetId: uploadResult.dataSetId,
    provider: { id: providerId, name: providerName },
    previewURL,
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
