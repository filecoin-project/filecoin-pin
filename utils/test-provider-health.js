#!/usr/bin/env node

/**
 * Storage Provider Health Check Script
 *
 * This script tests the complete workflow of a storage provider by:
 * 1. Creating a CAR file with random data (multiple 5MiB blocks)
 * 2. Uploading to a specific provider with IPFS indexing enabled
 * 3. Monitoring piece status including IPNI indexing workflow
 * 4. Downloading and verifying the piece data
 * 5. Verifying all CIDs are discoverable on IPNI with correct multiaddr
 *
 * Usage:
 *   PRIVATE_KEY=0x... node test-provider-health.js
 *
 * The script will exit with:
 *   - 0 on success (all checks passed)
 *   - 1 on failure (timeout, upload error, IPNI verification failed, etc.)
 */

import { Readable } from 'node:stream'
import { request } from 'node:https'
import { METADATA_KEYS, Synapse } from '@filoz/synapse-sdk'
import { PDPServer } from '@filoz/synapse-sdk/pdp'
import { CarWriter } from '@ipld/car'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'

// ============================================================================
// CONFIGURATION
// ============================================================================

const PROVIDER_ID = 22 // Provider to test
const CAR_SIZE_MB = 10 // Raw block size in MiB
const FORCE_CREATE_DATASET = false // Force new dataset each run
const POLLING_INTERVAL_MS = 2500 // Check status every 2.5 seconds
const POLLING_TIMEOUT_MS = 10 * 60 * 1000 // 10 minute timeout for status polling
const IPNI_LOOKUP_TIMEOUT_MS = 10 * 60 * 1000 // 10 minute timeout for IPNI lookups
const PRIVATE_KEY = process.env.PRIVATE_KEY // Only env var

// ============================================================================
// LOGGING UTILITIES
// ============================================================================

function log(message, prefix = '') {
  const timestamp = new Date().toISOString()
  const prefixStr = prefix ? `[${prefix}] ` : ''
  console.log(`[${timestamp}] ${prefixStr}${message}`)
}

function logSection(title) {
  console.log()
  console.log(`=== ${title} ===`)
}

// ============================================================================
// CAR GENERATION
// ============================================================================

/**
 * Generate random data in chunks (crypto.getRandomValues has 65536 byte limit)
 */
function generateRandomData(sizeInBytes) {
  const data = new Uint8Array(sizeInBytes)
  const chunkSize = 65536
  for (let i = 0; i < sizeInBytes; i += chunkSize) {
    const chunk = data.subarray(i, Math.min(i + chunkSize, sizeInBytes))
    crypto.getRandomValues(chunk)
  }
  return data
}

/**
 * Generate a CAR file with multiple random IPLD blocks
 * Returns the CAR data, root CID, and metadata
 *
 * go-car has a limit of 8MiB per block, so we split large CARs into multiple blocks
 * of max 5MiB each to be safe. We use the first block as the root CID.
 */
async function generateTestCAR(targetSizeBytes) {
  const MAX_BLOCK_SIZE = 5 * 1024 * 1024 // 5 MiB per block (safe under go-car 8MiB limit)

  // Calculate how many blocks we need
  const numBlocks = Math.ceil(targetSizeBytes / MAX_BLOCK_SIZE)
  const blocks = []

  log(`Generating ${numBlocks} block(s) to reach ~${targetSizeBytes.toLocaleString()} bytes`)

  // Generate blocks
  for (let i = 0; i < numBlocks; i++) {
    const blockSize =
      i === numBlocks - 1
        ? targetSizeBytes - i * MAX_BLOCK_SIZE // Last block gets remainder
        : MAX_BLOCK_SIZE

    const blockData = generateRandomData(blockSize)
    const hash = await sha256.digest(blockData)
    const cid = CID.create(1, raw.code, hash)

    blocks.push({ cid, bytes: blockData })
    log(`  Block ${i + 1}: ${blockSize.toLocaleString()} bytes, CID: ${cid.toString()}`)
  }

  // Use first block as root
  const rootCID = blocks[0].cid

  // Create CAR file with first block as root
  const { writer, out } = CarWriter.create([rootCID])

  // Collect CAR output into a Uint8Array
  const chunks = []
  const carStream = Readable.from(out)

  carStream.on('data', (chunk) => {
    chunks.push(chunk)
  })

  // Write all blocks to CAR
  const writePromise = (async () => {
    for (const block of blocks) {
      await writer.put(block)
    }
    await writer.close()
  })()

  // Wait for both writing and collecting to complete
  await writePromise
  await new Promise((resolve, reject) => {
    carStream.on('end', resolve)
    carStream.on('error', reject)
  })

  // Combine chunks into single Uint8Array
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const carData = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    carData.set(chunk, offset)
    offset += chunk.length
  }

  const totalBlockSize = blocks.reduce((sum, b) => sum + b.bytes.length, 0)
  const blockCIDs = blocks.map((b) => b.cid)

  return {
    carData,
    rootCID,
    blockCIDs,
    blockCount: blocks.length,
    totalBlockSize,
    carSize: carData.length,
  }
}

// ============================================================================
// STATUS MONITORING
// ============================================================================

/**
 * Monitor piece status until retrieved or timeout
 * Logs changes to indexed, advertised, retrieved, retrievedAt
 */
async function monitorPieceStatus(pdpServer, pieceCid, maxDurationMs, pollIntervalMs) {
  log(`Starting status monitoring (pieceCid: ${pieceCid})`, 'STATUS')

  const startTime = Date.now()
  let lastStatus = {
    status: '',
    indexed: false,
    advertised: false,
    retrieved: false,
    retrievedAt: null,
  }
  let checkCount = 0

  while (Date.now() - startTime < maxDurationMs) {
    checkCount++

    try {
      const status = await pdpServer.getPieceStatus(pieceCid)

      // Log changes only
      if (status.status !== lastStatus.status) {
        log(`Status changed: ${lastStatus.status || 'unknown'} → ${status.status}`, 'STATUS')
      }
      if (status.indexed !== lastStatus.indexed) {
        log(`✓ Indexed: ${status.indexed}`, 'STATUS')
      }
      if (status.advertised !== lastStatus.advertised) {
        log(`✓ Advertised: ${status.advertised}`, 'STATUS')
      }
      if (status.retrieved !== lastStatus.retrieved) {
        log(`✓ Retrieved: ${status.retrieved}`, 'STATUS')
      }
      if (status.retrievedAt && !lastStatus.retrievedAt) {
        log(`✓ RetrievedAt: ${status.retrievedAt}`, 'STATUS')
        // Success! Piece has been retrieved
        return {
          success: true,
          finalStatus: status,
          checks: checkCount,
          durationMs: Date.now() - startTime,
        }
      }

      // Log periodic check (every 10 checks to reduce noise)
      if (checkCount % 10 === 0) {
        log(
          `Check ${checkCount}: indexed=${status.indexed}, advertised=${status.advertised}, retrieved=${status.retrieved}`,
          'STATUS'
        )
      }

      lastStatus = status
    } catch (error) {
      log(`Error checking status: ${error.message}`, 'STATUS')
      // Don't fail on individual check errors, keep trying
    }

    // Wait before next check
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }

  // Timeout reached
  const durationMs = Date.now() - startTime
  log(`Timeout after ${(durationMs / 1000).toFixed(1)}s, final status: ${JSON.stringify(lastStatus)}`, 'STATUS')
  throw new Error(`Timeout waiting for piece retrieval (${checkCount} checks over ${(durationMs / 1000).toFixed(1)}s)`)
}

/**
 * Monitor piece status, then verify IPNI advertisement
 * This runs after upload completes - status monitoring followed by IPNI checks
 */
async function monitorAndVerifyIPNI(pdpServer, pieceCid, blockCIDs, expectedMultiaddr, statusTimeoutMs, ipniTimeoutMs, pollIntervalMs) {
  // First, wait for piece to be retrieved
  const monitoringResult = await monitorPieceStatus(pdpServer, pieceCid, statusTimeoutMs, pollIntervalMs)

  // Once retrieved, verify IPNI advertisement
  logSection('IPNI VERIFICATION')
  log(`Piece retrieved, now verifying IPNI advertisement`)

  const ipniResult = await verifyIPNIAdvertisement(blockCIDs, expectedMultiaddr, ipniTimeoutMs)

  log(`✓ IPNI verification complete: ${ipniResult.verified}/${ipniResult.total} CIDs verified in ${(ipniResult.durationMs / 1000).toFixed(1)}s`)

  return {
    monitoringResult,
    ipniResult,
  }
}

// ============================================================================
// IPNI VERIFICATION
// ============================================================================
//
// Note on Node.js Happy Eyeballs and IPv6:
// ----------------------------------------
// Node.js v18+ uses Happy Eyeballs v2 (RFC 8305) with a default
// autoSelectFamilyAttemptTimeout of 250ms. This is too aggressive for networks
// where IPv4 connections take longer to establish and IPv6 is unavailable.
// Unfortunately we can't use fetch() here because it doesn't expose this option.
//
// See https://github.com/nodejs/node/pull/60334 to track progress upstream.

/**
 * Convert a serviceURL to expected multiaddr format
 * e.g., "https://polynomial.pro/" -> "/dns/polynomial.pro/tcp/443/https"
 */
function serviceURLToMultiaddr(serviceURL) {
  try {
    const url = new URL(serviceURL)
    const hostname = url.hostname
    const protocol = url.protocol.replace(':', '')
    if (protocol !== 'https') {
      throw new Error(`Only HTTPS protocol is supported for PDP serviceURL, got: ${protocol}`)
    }
    return `/dns/${hostname}/tcp/443/https`
  } catch (error) {
    throw new Error(`Failed to convert serviceURL to multiaddr: ${error.message}`)
  }
}

/**
 * Make an HTTPS GET request with increased Happy Eyeballs timeout. This is a
 * poor-man's fetch() replacement to allow setting
 * autoSelectFamilyAttemptTimeout. See note above.
 */
function httpsGet(hostname, path, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path,
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'filecoin-pin-health-check/1.0',
        'Accept': 'application/json',
      },
      autoSelectFamilyAttemptTimeout: 500,
    }

    const req = request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk.toString() })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`))
          return
        }
        try {
          resolve(JSON.parse(data))
        } catch (error) {
          reject(new Error(`Failed to parse JSON response: ${error.message}`))
        }
      })
    })

    req.on('error', (error) => {
      reject(new Error(`Request failed: ${error.message} (${error.code || 'unknown'})`))
    })

    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`Request timed out after ${timeoutMs}ms`))
    })

    req.end()
  })
}

/**
 * Extract provider multiaddrs from IPNI response
 */
function extractProviderAddrs(ipniResponse) {
  const providerAddrs = []
  for (const multihashResult of ipniResponse.MultihashResults || []) {
    for (const providerResult of multihashResult.ProviderResults || []) {
      if (providerResult.Provider?.Addrs) {
        providerAddrs.push(...providerResult.Provider.Addrs)
      }
    }
  }
  return providerAddrs
}

/**
 * Query filecoinpin.contact for a CID and return provider multiaddrs
 */
async function queryIPNI(cid, timeoutMs = 5000) {
  const response = await httpsGet('filecoinpin.contact', `/cid/${cid.toString()}`, timeoutMs)
  return extractProviderAddrs(response)
}

/**
 * Verify all CIDs are discoverable on IPNI with correct provider
 */
async function verifyIPNIAdvertisement(blockCIDs, expectedMultiaddr, maxDurationMs) {
  log(`Verifying ${blockCIDs.length} CID(s) on IPNI`, 'IPNI')
  log(`Expected multiaddr: ${expectedMultiaddr}`, 'IPNI')

  const startTime = Date.now()
  let successCount = 0
  let failedCIDs = []

  for (let i = 0; i < blockCIDs.length; i++) {
    const cid = blockCIDs[i]
    const elapsed = Date.now() - startTime

    if (elapsed > maxDurationMs) {
      throw new Error(`IPNI verification timeout after ${(elapsed / 1000).toFixed(1)}s (verified ${successCount}/${blockCIDs.length})`)
    }

    try {
      log(`Checking CID ${i + 1}/${blockCIDs.length}: ${cid.toString()}`, 'IPNI')

      const addrs = await queryIPNI(cid, 5000)

      if (addrs.length === 0) {
        log(`✗ CID not found on IPNI`, 'IPNI')
        failedCIDs.push({ cid: cid.toString(), reason: 'not found' })
        continue
      }

      // Check if our expected multiaddr is in the results
      if (!addrs.includes(expectedMultiaddr)) {
        log(`✗ Expected multiaddr not found. Got: ${addrs.join(', ')}`, 'IPNI')
        failedCIDs.push({ cid: cid.toString(), reason: 'wrong multiaddr', addrs })
        continue
      }

      log(`✓ CID found with correct multiaddr`, 'IPNI')
      successCount++
    } catch (error) {
      log(`✗ Error querying CID: ${error.message}`, 'IPNI')
      failedCIDs.push({ cid: cid.toString(), reason: error.message })
    }
  }

  const durationMs = Date.now() - startTime

  if (failedCIDs.length > 0) {
    throw new Error(
      `IPNI verification failed: ${successCount}/${blockCIDs.length} CIDs verified. ` +
      `Failed CIDs: ${JSON.stringify(failedCIDs, null, 2)}`
    )
  }

  return {
    verified: successCount,
    total: blockCIDs.length,
    durationMs,
  }
}

// ============================================================================
// MAIN WORKFLOW
// ============================================================================

async function main() {
  const scriptStartTime = Date.now()

  try {
    // Validate environment
    if (!PRIVATE_KEY) {
      console.error('ERROR: PRIVATE_KEY environment variable is required')
      console.error('Usage: PRIVATE_KEY=0x... node test-provider-health.js')
      process.exit(1)
    }

    // ========================================================================
    // INITIALIZATION PHASE
    // ========================================================================

    logSection('INITIALIZATION')
    log('Starting provider health check')
    log(`Config: Provider ID=${PROVIDER_ID}, CAR=${CAR_SIZE_MB} MiB, ForceCreate=${FORCE_CREATE_DATASET}`)
    log(`Polling: interval=${POLLING_INTERVAL_MS}ms, timeout=${POLLING_TIMEOUT_MS / 1000}s`)

    log('Initializing Synapse SDK...')
    const synapse = await Synapse.create({
      privateKey: PRIVATE_KEY,
      rpcURL: 'https://api.calibration.node.glif.io/rpc/v1',
    })

    const walletAddress = await synapse.getSigner().getAddress()
    log(`Wallet address: ${walletAddress}`)

    log('Creating storage context...')
    const storage = await synapse.storage.createContext({
      providerId: PROVIDER_ID,
      forceCreateDataSet: FORCE_CREATE_DATASET,
      metadata: {
        [METADATA_KEYS.WITH_IPFS_INDEXING]: '', // Request IPFS indexing
      },
    })

    const providerInfo = storage.provider
    log(`Provider: ${providerInfo.name || 'Unknown'} (ID: ${providerInfo.id}, ${providerInfo.serviceProvider})`)

    const pdpServiceURL = providerInfo.products?.PDP?.data?.serviceURL
    if (!pdpServiceURL) {
      throw new Error('Provider does not have a PDP service URL')
    }
    log(`PDP URL: ${pdpServiceURL}`)
    log(`Data set ID: ${storage.dataSetId}`)

    // ========================================================================
    // CAR GENERATION PHASE
    // ========================================================================

    logSection('CAR GENERATION')
    const targetSizeBytes = CAR_SIZE_MB * 1024 * 1024
    log(`Target size: ${targetSizeBytes.toLocaleString()} bytes`)

    const { carData, rootCID, blockCIDs, blockCount, totalBlockSize, carSize } = await generateTestCAR(targetSizeBytes)

    log(`Root CID: ${rootCID.toString()}`)
    log(`Total blocks: ${blockCount}`)
    log(`Total block data: ${totalBlockSize.toLocaleString()} bytes`)
    log(`CAR size: ${carSize.toLocaleString()} bytes`)

    // ========================================================================
    // UPLOAD + MONITORING PHASE (PARALLEL)
    // ========================================================================

    logSection('UPLOAD + MONITORING')
    log('Starting upload...', 'UPLOAD')

    // Convert serviceURL to expected multiaddr for IPNI verification
    const expectedMultiaddr = serviceURLToMultiaddr(pdpServiceURL)

    // We'll track when monitoring + IPNI verification should start
    let verificationPromise = null
    let pieceCidForMonitoring = null

    const uploadPromise = storage.upload(carData, {
      metadata: {
        [METADATA_KEYS.IPFS_ROOT_CID]: rootCID.toString(),
      },
      onUploadComplete: (pieceCid) => {
        log(`Upload complete: ${pieceCid}`, 'UPLOAD')

        // Start status monitoring + IPNI verification immediately
        // This will monitor status, then once retrievedAt is set, start IPNI checks
        pieceCidForMonitoring = pieceCid.toString()
        const pdpServer = new PDPServer(null, pdpServiceURL)
        verificationPromise = monitorAndVerifyIPNI(
          pdpServer,
          pieceCidForMonitoring,
          blockCIDs,
          expectedMultiaddr,
          POLLING_TIMEOUT_MS,
          IPNI_LOOKUP_TIMEOUT_MS,
          POLLING_INTERVAL_MS
        )
      },
      onPieceAdded: (transaction) => {
        if (transaction) {
          log(`Piece added, tx: ${transaction.hash}`, 'UPLOAD')
        } else {
          log('Piece added to data set', 'UPLOAD')
        }
      },
      onPieceConfirmed: (pieceIds) => {
        log(`Piece confirmed: IDs ${pieceIds.join(', ')}`, 'UPLOAD')
      },
    })

    // Wait for upload to complete (this also ensures onUploadComplete has fired)
    const uploadResult = await uploadPromise
    log(`Upload result: pieceCid=${uploadResult.pieceCid}, pieceId=${uploadResult.pieceId}`, 'UPLOAD')

    // Ensure verification started (it should have via onUploadComplete)
    if (!verificationPromise) {
      throw new Error('Verification did not start - onUploadComplete was not called')
    }

    // Wait for monitoring + IPNI verification to complete (runs in parallel with upload confirmation)
    const { monitoringResult, ipniResult } = await verificationPromise

    // ========================================================================
    // DOWNLOAD & VERIFICATION PHASE
    // ========================================================================

    logSection('DOWNLOAD & VERIFICATION')
    log(`Downloading piece: ${uploadResult.pieceCid}`)

    const downloadedData = await storage.download(uploadResult.pieceCid)
    log(`Downloaded ${downloadedData.length.toLocaleString()} bytes`)

    // Verify the downloaded data matches the original CAR
    const dataMatches =
      downloadedData.length === carData.length && downloadedData.every((byte, index) => byte === carData[index])

    if (!dataMatches) {
      throw new Error(
        `Downloaded data does not match original CAR! Downloaded: ${downloadedData.length} bytes, Original: ${carData.length} bytes`
      )
    }

    log(`✓ Downloaded data matches original CAR (${carData.length.toLocaleString()} bytes verified)`)

    // ========================================================================
    // SUCCESS
    // ========================================================================

    const totalDurationMs = Date.now() - scriptStartTime
    const totalDurationSec = (totalDurationMs / 1000).toFixed(1)

    logSection('SUCCESS')
    log(`✅ Provider health check PASSED`)
    log(`Total duration: ${totalDurationSec}s`)
    log(
      `Final status: indexed=${monitoringResult.finalStatus.indexed}, advertised=${monitoringResult.finalStatus.advertised}, retrieved=${monitoringResult.finalStatus.retrieved}`
    )
    log(`Upload confirmed: dataSetId=${storage.dataSetId}, pieceId=${uploadResult.pieceId}`)
    log(`Monitoring: ${monitoringResult.checks} status checks over ${(monitoringResult.durationMs / 1000).toFixed(1)}s`)
    log(`IPNI verification: ${ipniResult.verified}/${ipniResult.total} CIDs verified in ${(ipniResult.durationMs / 1000).toFixed(1)}s`)

    process.exit(0)
  } catch (error) {
    const totalDurationMs = Date.now() - scriptStartTime
    const totalDurationSec = (totalDurationMs / 1000).toFixed(1)

    logSection('FAILURE')
    log(`❌ Provider health check FAILED after ${totalDurationSec}s`)
    log(`Error: ${error.message}`)
    if (error.stack) {
      console.error(error.stack)
    }
    process.exit(1)
  }
}

// Run the script
main().catch((error) => {
  console.error('Unhandled error:', error)
  process.exit(1)
})
