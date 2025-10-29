import { promises as fs } from 'node:fs'
import { ethers } from 'ethers'
import { formatUSDFC } from 'filecoin-pin/core/utils'
import { getErrorMessage } from './errors.js'

/**
 * @typedef {import('./types.js').CombinedContext} CombinedContext
 * @typedef {import('./types.js').PaymentStatus} PaymentStatus
 */

/**
 * Format file size in bytes to human-readable string
 * @param {number | undefined} size - Size in bytes
 * @returns {string} Formatted size string
 */
export function formatSize(size) {
  if (!size) return 'Unknown'
  if (size < 1024) return `${size} bytes`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/**
 * Write output to GitHub Actions output file
 * @param {string} name - Output name
 * @param {any} value - Output value
 */
export async function writeOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT
  if (!file) return
  await fs.appendFile(file, `\n${name}=${String(value ?? '')}\n`)
}

/**
 * Write multiple outputs at once
 * @param {Object} outputs - Object with output name/value pairs
 */
export async function writeOutputs(outputs) {
  for (const [name, value] of Object.entries(outputs)) {
    await writeOutput(name, value)
  }
}

/**
 * Write summary to GitHub Actions step summary
 * @param {CombinedContext} context - Combined context data
 * @param {string} status - Upload status
 */
export async function writeSummary(context, status) {
  try {
    const summaryFile = process.env.GITHUB_STEP_SUMMARY
    if (!summaryFile) {
      console.warn('No summary file found, GITHUB_STEP_SUMMARY is not set')
      return
    }

    await fs.appendFile(summaryFile, `\n${getOutputSummary(context, status)}\n`)
  } catch (error) {
    console.error('Failed to write summary:', getErrorMessage(error))
  }
}

/**
 * Get the output summary
 * @param {CombinedContext} context - Combined context data
 * @param {string} status - Upload status
 * @returns {string} The output summary
 */
export function getOutputSummary(context, status) {
  const network = context?.network || ''
  const ipfsRootCid = context?.ipfsRootCid || ''
  const dataSetId = context?.dataSetId || ''
  const pieceCid = context?.pieceCid || ''
  const provider = context?.provider || {}
  const providerAddress = context?.providerAddress || provider?.address || ''
  const previewUrl = context?.previewUrl || ''
  const carPath = context?.carPath || ''
  const carSize = context?.carSize
  const carDownloadUrl = context?.carDownloadUrl || (carPath ? `[download link](${carPath})` : 'download')
  /** @type {PaymentStatus} */
  const paymentStatus = {
    filecoinPayBalance: '0',
    storageRunway: 'Unknown',
    depositedThisRun: '0',
    network,
    address: 'Unknown',
    filBalance: 0n,
    walletUsdfcBalance: '0',
    currentAllowances: {
      rateAllowance: 0n,
      lockupAllowance: 0n,
      lockupUsed: 0n,
    },
    ...context?.paymentStatus,
  }

  return [
    '## Filecoin Pin Upload',
    '',
    '**IPFS Artifacts:**',
    `* IPFS Root CID: ${ipfsRootCid}`,
    `* Centralized IPFS HTTP Gateway Preview: ${ipfsRootCid ? `https://dweb.link/ipfs/${ipfsRootCid}` : 'IPFS Root CID unavailable'}`,
    `* In-Browser IPFS HTTP Gateway Preview: ${ipfsRootCid ? `https://inbrowser.link/ipfs/${ipfsRootCid}` : 'IPFS Root CID unavailable'}`,
    `* Status: ${status}`,
    `* Generated CAR on GitHub: ${carDownloadUrl}`,
    `* CAR file size: ${formatSize(carSize)}`,
    '',
    '**Onchain verification:**',
    `* Network: ${network}`,
    `* Data Set ID: [${dataSetId}](https://pdp.vxb.ai/${network || 'mainnet'}/dataset/${dataSetId})`,
    `* Piece CID: [${pieceCid}](https://pdp.vxb.ai/${network || 'mainnet'}/piece/${pieceCid})`,
    `* Provider: [${provider?.name || 'Unknown'} (ID ${provider?.id || 'Unknown'})](https://pdp.vxb.ai/${network || 'mainnet'}/providers/${providerAddress})`,
    `* Piece download direct from provider: ${previewUrl}`,
    '',
    '**Payment:**',
    `* Current Filecoin Pay balance: ${formatUSDFC(ethers.parseUnits(paymentStatus.filecoinPayBalance, 18))} USDFC`,
    `* Amount deposited to Filecoin Pay by this workflow: ${formatUSDFC(ethers.parseUnits(paymentStatus.depositedThisRun, 18))} USDFC`,
    `* Data Set Storage runway: ${paymentStatus.storageRunway}`,
    '',
  ].join('\n')
}
