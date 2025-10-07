import { promises as fs } from 'node:fs'
import { RPC_URLS } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'
import { createCarFromPath } from 'filecoin-pin/add/unixfs-car.js'
import { validatePaymentSetup } from 'filecoin-pin/common/upload-flow.js'
import { calculateStorageRunway, computeTopUpForDuration, initializeSynapse as initSynapse } from 'filecoin-pin/core'
import { checkAndSetAllowances, depositUSDFC, getPaymentStatus } from 'filecoin-pin/synapse/payments.js'
import {
  cleanupSynapseService,
  createStorageContext,
} from 'filecoin-pin/synapse/service.js'
import { getDownloadURL, uploadToSynapse } from 'filecoin-pin/synapse/upload.js'
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

  // Ensure WarmStorage allowances are at max
  await checkAndSetAllowances(synapse)

  // Check current payment status
  const initialStatus = await getPaymentStatus(synapse)
  let newStatus = initialStatus

  // Compute top-up to satisfy minStorageDays
  let requiredTopUp = 0n
  if (minStorageDays > 0) {
    const { topUp } = computeTopUpForDuration(initialStatus, minStorageDays)
    if (topUp > requiredTopUp) requiredTopUp = topUp
  }

  // Check if deposit would exceed maximum balance if specified
  if (filecoinPayBalanceLimit != null && filecoinPayBalanceLimit >= 0n) {
    // Check if current balance already equals or exceeds limit
    if (initialStatus.depositedAmount >= filecoinPayBalanceLimit) {
      logger.warn(
        `⚠️  Current balance (${ethers.formatUnits(initialStatus.depositedAmount, 18)} USDFC) already equals or exceeds filecoinPayBalanceLimit (${ethers.formatUnits(filecoinPayBalanceLimit, 18)} USDFC). No additional deposits will be made.`
      )
      requiredTopUp = 0n // Don't deposit anything
    } else {
      // Check if required top-up would exceed the limit
      const projectedBalance = initialStatus.depositedAmount + requiredTopUp
      if (projectedBalance > filecoinPayBalanceLimit) {
        // Calculate the maximum allowed top-up that won't exceed the limit
        const maxAllowedTopUp = filecoinPayBalanceLimit - initialStatus.depositedAmount

        if (maxAllowedTopUp <= 0n) {
          // This shouldn't happen due to the check above, but just in case
          logger.warn(
            `⚠️  Cannot deposit any amount without exceeding filecoinPayBalanceLimit (${ethers.formatUnits(filecoinPayBalanceLimit, 18)} USDFC). No additional deposits will be made.`
          )
          requiredTopUp = 0n
        } else {
          // Reduce the top-up to fit within the limit
          logger.warn(
            `⚠️  Required top-up (${ethers.formatUnits(requiredTopUp, 18)} USDFC) would exceed filecoinPayBalanceLimit (${ethers.formatUnits(filecoinPayBalanceLimit, 18)} USDFC). Reducing to ${ethers.formatUnits(maxAllowedTopUp, 18)} USDFC.`
          )
          requiredTopUp = maxAllowedTopUp
        }
      }
    }
  }

  if (requiredTopUp > 0n) {
    logger.info(`Depositing ${ethers.formatUnits(requiredTopUp, 18)} USDFC to Filecoin Pay ...`)
    await depositUSDFC(synapse, requiredTopUp)
    newStatus = await getPaymentStatus(synapse)
  } else {
    requiredTopUp = 0n
  }

  return {
    ...initialStatus,
    // the amount of USDFC you have deposited to Filecoin Pay
    depositedAmount: ethers.formatUnits(newStatus.depositedAmount, 18),
    // the amount of USDFC you have in your wallet
    currentBalance: ethers.formatUnits(newStatus.usdfcBalance, 18),
    // the amount of time you have until your funds would run out based on storage usage
    storageRunway: calculateStorageRunway(newStatus).formatted,
    // the amount of USDFC you have deposited to Filecoin Pay in this run
    depositedThisRun: ethers.formatUnits(requiredTopUp, 18),
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
    const stat = await fs.stat(targetPath)
    const isDirectory = stat.isDirectory()
    logger.info(`Packing '${contentPath}' into CAR (UnixFS) ...`)

    const result = await createCarFromPath(targetPath, { isDirectory, logger })
    const { carPath, rootCid } = result

    // Handle different possible return formats from filecoin-pin
    if (!rootCid) {
      throw new FilecoinPinError(
        `createCarFromPath returned unexpected format: ${JSON.stringify(Object.keys(result))}`,
        ERROR_CODES.CAR_CREATE_FAILED
      )
    }

    // Get CAR file size from filesystem since stats are not returned in the interface
    let carSize
    if (carPath) {
      try {
        const stat = await fs.stat(carPath)
        carSize = stat.size
      } catch (error) {
        logger.warn(`Failed to get CAR file size: ${getErrorMessage(error)}`)
      }
    }

    return { carPath, ipfsRootCid: rootCid.toString(), contentPath, carSize }
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

  // Validate payment capacity
  await validatePaymentSetup(synapse, carBytes.length)

  // Create storage context with optional CDN flag
  if (withCDN) process.env.WITH_CDN = 'true'
  const { storage, providerInfo } = await createStorageContext(synapse, logger, {})

  // Upload to Filecoin via filecoin-pin
  const synapseService = { synapse, storage, providerInfo }
  const cid = CID.parse(ipfsRootCid)
  const { pieceCid, pieceId, dataSetId } = await uploadToSynapse(synapseService, carBytes, cid, logger, {
    contextId: `gha-upload-${Date.now()}`,
  })

  const providerId = String(providerInfo.id ?? '')
  const providerName = providerInfo.name ?? (providerInfo.serviceProvider || '')
  const previewURL = getDownloadURL(providerInfo, pieceCid) || `https://ipfs.io/ipfs/${ipfsRootCid}`

  return {
    pieceCid,
    pieceId: pieceId != null ? String(pieceId) : '',
    dataSetId,
    provider: { id: providerId, name: providerName },
    previewURL,
    network: synapse.getNetwork(),
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
