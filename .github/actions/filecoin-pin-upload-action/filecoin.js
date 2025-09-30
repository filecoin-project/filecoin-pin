import { promises as fs } from 'node:fs'
import { ethers } from 'ethers'
import { createCarFromPath } from 'filecoin-pin/dist/add/unixfs-car.js'
import { validatePaymentSetup } from 'filecoin-pin/dist/common/upload-flow.js'
import {
  checkAndSetAllowances,
  computeTopUpForDuration,
  depositUSDFC,
  getPaymentStatus,
} from 'filecoin-pin/dist/synapse/payments.js'
// Import filecoin-pin internals
import {
  cleanupSynapseService,
  createStorageContext,
  initializeSynapse as initSynapse,
} from 'filecoin-pin/dist/synapse/service.js'
import { getDownloadURL, uploadToSynapse } from 'filecoin-pin/dist/synapse/upload.js'

import { ERROR_CODES, FilecoinPinError } from './errors.js'

/**
 * Initialize Synapse sdk with error handling
 * @param {string} privateKey - Wallet private key
 * @param {Object} logger - Logger instance
 * @returns {Object} Synapse service
 */
export async function initializeSynapse(privateKey, logger) {
  try {
    return await initSynapse({ privateKey }, logger)
  } catch (error) {
    if (error.message?.includes('invalid private key')) {
      throw new FilecoinPinError('Invalid private key format', ERROR_CODES.INVALID_PRIVATE_KEY)
    }
    throw new FilecoinPinError(`Failed to initialize Synapse: ${error.message}`, ERROR_CODES.NETWORK_ERROR)
  }
}

/**
 * Handle payment setup and top-ups
 * @param {Object} synapse - Synapse service
 * @param {Object} options - Payment options
 * @param {Object} logger - Logger instance
 * @returns {Object} Updated payment status
 */
export async function handlePayments(synapse, options, logger) {
  const { minDays, minBalance, maxTopUp } = options

  // Ensure WarmStorage allowances are at max
  await checkAndSetAllowances(synapse)

  // Check current payment status
  let status = await getPaymentStatus(synapse)

  // Compute top-up to satisfy minDays
  let requiredTopUp = 0n
  if (minDays > 0) {
    const { topUp } = computeTopUpForDuration(status, minDays)
    if (topUp > requiredTopUp) requiredTopUp = topUp
  }

  // Ensure minimum deposit balance if specified
  if (minBalance > 0n && status.depositedAmount < minBalance) {
    const delta = minBalance - status.depositedAmount
    if (delta > requiredTopUp) requiredTopUp = delta
  }

  if (requiredTopUp > 0n) {
    if (maxTopUp != null && requiredTopUp > maxTopUp) {
      throw new FilecoinPinError(
        `Top-up required (${ethers.formatUnits(requiredTopUp, 18)} USDFC) exceeds maxTopUp (${ethers.formatUnits(maxTopUp, 18)} USDFC)`,
        ERROR_CODES.INSUFFICIENT_FUNDS
      )
    }

    logger.info(`Depositing ${ethers.formatUnits(requiredTopUp, 18)} USDFC to Filecoin Pay ...`)
    await depositUSDFC(synapse, requiredTopUp)
    status = await getPaymentStatus(synapse)
  }

  return status
}

/**
 * Create CAR file from content path
 * @param {string} targetPath - Path to content
 * @param {string} contentPath - Original content path for logging
 * @param {Object} logger - Logger instance
 * @returns {Object} CAR file info
 */
export async function createCarFile(targetPath, contentPath, logger) {
  try {
    const stat = await fs.stat(targetPath)
    const isDirectory = stat.isDirectory()
    logger.info(`Packing '${contentPath}' into CAR (UnixFS) ...`)

    const { carPath, rootCid } = await createCarFromPath(targetPath, { isDirectory, logger })
    return { carPath, rootCid: rootCid.toString() }
  } catch (error) {
    throw new FilecoinPinError(`Failed to create CAR file: ${error.message}`, ERROR_CODES.UPLOAD_FAILED)
  }
}

/**
 * Upload CAR to Filecoin via filecoin-pin
 * @param {Object} synapse - Synapse service
 * @param {string} carPath - Path to CAR file
 * @param {string} rootCid - Root CID
 * @param {Object} options - Upload options
 * @param {Object} logger - Logger instance
 * @returns {Object} Upload result
 */
export async function uploadCarToFilecoin(synapse, carPath, rootCid, options, logger) {
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
  const { pieceCid, pieceId, dataSetId } = await uploadToSynapse(
    synapseService,
    carBytes,
    { toString: () => rootCid },
    logger,
    { contextId: `gha-upload-${Date.now()}` }
  )

  const providerId = providerInfo.id ?? ''
  const providerName = providerInfo.name ?? (providerInfo.serviceProvider || '')
  const previewURL = getDownloadURL(providerInfo, pieceCid) || `https://ipfs.io/ipfs/${rootCid}`

  return {
    pieceCid,
    pieceId,
    dataSetId,
    provider: { id: providerId, name: providerName },
    previewURL,
    network: synapse.getNetwork(),
  }
}

/**
 * Cleanup filecoin-pin service
 */
export async function cleanupSynapse() {
  try {
    await cleanupSynapseService()
  } catch (error) {
    console.error('Cleanup failed:', error?.message || error)
  }
}
