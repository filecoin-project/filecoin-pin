#!/usr/bin/env node

/**
 * Debug script to analyze upload size limits and payment capacity
 *
 * Usage: npx tsx src/debug/upload-size-limits.ts <file-path>
 */

import { RPC_URLS, SIZE_CONSTANTS, Synapse, TIME_CONSTANTS } from '@filoz/synapse-sdk'
import { ethers } from 'ethers'
import { stat } from 'fs/promises'
import { formatUSDFC } from '../payments/setup.js'
import { calculateRequiredAllowances, getPaymentStatus } from '../synapse/payments.js'
import { cleanupProvider } from '../synapse/service.js'
import { calculateCapacityForDuration } from '../utils/capacity/capacity-for-duration.js'
import { calculateMaxDurationForFileSize } from '../utils/capacity/max-duration-for-file-size.js'
import { calculateMaxUploadableFileSize } from '../utils/capacity/max-uploadable-file-size.js'
import { convert, getStorageUnitBI, makeStorageUnit, toBytes } from '../utils/capacity/units.js'
import { formatStorageSize } from '../utils/display/format-storage-sizes.js'

function formatCapacityFromTiB(capacityTiB: number, precision = 2): string {
  if (!Number.isFinite(capacityTiB) || capacityTiB <= 0) {
    return '0 B'
  }

  const capacityUnit = makeStorageUnit(capacityTiB, 'TiB')
  const normalizedUnit = getStorageUnitBI(toBytes(capacityUnit))
  return formatStorageSize(normalizedUnit, precision)
}

const CAPACITY_DURATIONS = [
  { days: 1, label: '1 day' },
  { days: 10, label: '10 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
]

function logAllowanceCapacity(label: 'Rate' | 'Lockup', allowance: bigint, pricePerTiBPerEpoch: bigint): void {
  const allowanceLabel = label === 'Rate' ? 'USDFC/epoch' : 'USDFC'
  console.log(`${label} allowance: ${formatUSDFC(allowance)} ${allowanceLabel}`)

  if (label === 'Rate') {
    const perEpochCapacity = calculateCapacityForDuration(allowance, pricePerTiBPerEpoch, 1, {
      allowanceType: 'rate',
    })
    console.log(`  Max file size supported per epoch: ${formatCapacityFromTiB(perEpochCapacity, 4)}`)
    return
  }

  for (const { days, label: durationLabel } of CAPACITY_DURATIONS) {
    const capacityForDuration = calculateCapacityForDuration(allowance, pricePerTiBPerEpoch, days, {
      allowanceType: 'lockup',
    })
    console.log(`  Capacity for ${durationLabel}: ${formatCapacityFromTiB(capacityForDuration)}`)
  }
}

let provider: ethers.Provider | null = null
async function analyzeUploadLimits(filePath: string) {
  try {
    // Get file size
    const fileStat = await stat(filePath)
    const carSizeBytes = fileStat.size

    console.log(`Analyzing file: ${filePath}`)
    console.log(`File size: ${carSizeBytes} bytes`)
    console.log('')

    // Initialize Synapse (you'll need to provide your private key)
    const privateKey = process.env.PRIVATE_KEY
    if (!privateKey) {
      throw new Error('PRIVATE_KEY environment variable is required')
    }

    // TODO: Allow override of the RPC URL
    const rpcURL = RPC_URLS.calibration.websocket
    const synapse = await Synapse.create({
      privateKey,
      rpcURL,
    })

    // Store provider reference for cleanup if it's a WebSocket provider
    if (rpcURL.match(/^wss?:\/\//)) {
      provider = synapse.getProvider()
    }

    // Get current status and pricing
    const [status, storageInfo] = await Promise.all([getPaymentStatus(synapse), synapse.storage.getStorageInfo()])

    const pricePerTiBPerEpoch = storageInfo.pricing.noCDN.perTiBPerEpoch

    // === PRICING DEBUG ===
    console.log('=== PRICING DEBUG ===')
    console.log(`Price per TiB per epoch: ${formatUSDFC(pricePerTiBPerEpoch)} USDFC`)
    console.log(`Price per TiB per month: ${formatUSDFC(pricePerTiBPerEpoch * TIME_CONSTANTS.EPOCHS_PER_MONTH)} USDFC`)
    console.log(
      `Price per GiB per month: ${formatUSDFC((pricePerTiBPerEpoch * TIME_CONSTANTS.EPOCHS_PER_MONTH) / 1024n)} USDFC`
    )
    console.log(
      `Price per MiB per month: ${formatUSDFC((pricePerTiBPerEpoch * TIME_CONSTANTS.EPOCHS_PER_MONTH) / (1024n * 1024n))} USDFC`
    )
    console.log(
      `Price per KiB per month: ${formatUSDFC((pricePerTiBPerEpoch * TIME_CONSTANTS.EPOCHS_PER_MONTH) / (1024n * 1024n * 1024n))} USDFC`
    )

    // Calculate storageTiB with precision preservation
    const carSizeBytesBigInt = BigInt(carSizeBytes)
    const storageTiBBigInt = (carSizeBytesBigInt * BigInt(10000000)) / SIZE_CONSTANTS.TiB
    const storageTiB = Number(storageTiBBigInt) / 10000000

    // Calculate requirements
    const required = calculateRequiredAllowances(carSizeBytes, pricePerTiBPerEpoch)

    // === CALCULATION DEBUG ===
    console.log('=== CALCULATION DEBUG ===')
    console.log(`File size in bytes: ${carSizeBytes}`)
    console.log(`File size in TiB: ${storageTiB}`)
    console.log(`Price per TiB per epoch: ${formatUSDFC(pricePerTiBPerEpoch)} USDFC`)
    console.log(`Required rate allowance: ${formatUSDFC(required.rateAllowance)} USDFC/epoch`)
    console.log(`Required lockup allowance: ${formatUSDFC(required.lockupAllowance)} USDFC`)

    // === CURRENT STATUS ===
    console.log('=== CURRENT STATUS ===')
    console.log(`Network: ${status.network}`)
    console.log(`Address: ${status.address}`)
    console.log(`FIL Balance: ${ethers.formatEther(status.filBalance)} FIL`)
    console.log(`USDFC Balance: ${formatUSDFC(status.usdfcBalance)} USDFC`)
    console.log(`Deposited Amount: ${formatUSDFC(status.depositedAmount)} USDFC`)
    console.log('Current Allowances:')
    console.log(`  Rate Allowance: ${formatUSDFC(status.currentAllowances.rateAllowance)} USDFC/epoch`)
    console.log(`  Lockup Allowance: ${formatUSDFC(status.currentAllowances.lockupAllowance)} USDFC`)
    console.log(`  Rate Used: ${formatUSDFC(status.currentAllowances.rateUsed ?? 0n)} USDFC`)
    console.log(`  Lockup Used: ${formatUSDFC(status.currentAllowances.lockupUsed ?? 0n)} USDFC`)
    console.log(
      `  Max Lockup Period: ${status.currentAllowances.maxLockupPeriod} epochs (${Number(status.currentAllowances.maxLockupPeriod) / 2880} days)`
    )

    // === FILE REQUIREMENTS ===
    console.log('=== FILE REQUIREMENTS ===')
    const requiredStorageCapacityStorageUnit = makeStorageUnit(required.storageCapacityTiB, 'TiB')
    console.log(`File Size max: ${formatStorageSize(convert(requiredStorageCapacityStorageUnit, 'GiB'))}`)
    console.log(`File Size max: ${formatStorageSize(convert(requiredStorageCapacityStorageUnit, 'MiB'))}`)
    console.log(`File Size max: ${formatStorageSize(convert(requiredStorageCapacityStorageUnit, 'KiB'))}`)
    console.log(`Required Rate Allowance: ${formatUSDFC(required.rateAllowance)} USDFC/epoch`)
    console.log(`Required Lockup Allowance: ${formatUSDFC(required.lockupAllowance)} USDFC`)
    console.log(`Storage Capacity: ${formatStorageSize(convert(requiredStorageCapacityStorageUnit, 'TiB'))}`)

    // === CAPACITY ANALYSIS ===
    console.log('=== CAPACITY ANALYSIS ===')
    console.log(`carSizeBytes ${carSizeBytes}`)

    console.log('Rate capacity:')
    logAllowanceCapacity('Rate', status.currentAllowances.rateAllowance, pricePerTiBPerEpoch)

    console.log('Lockup capacity:')
    logAllowanceCapacity('Lockup', status.currentAllowances.lockupAllowance, pricePerTiBPerEpoch)

    const maxDurationForFileSize = calculateMaxDurationForFileSize({
      fileSize: carSizeBytesBigInt,
      rateAllowance: status.currentAllowances.rateAllowance,
      lockupAllowance: status.currentAllowances.lockupAllowance,
      pricePerTiBPerEpoch,
    })
    console.log(
      `maxDurationForFileSize { maxDurationDays: ${maxDurationForFileSize.maxDurationDays}, limitingFactor: '${maxDurationForFileSize.limitingFactor}' }`
    )

    const maxUploadableFileSize = calculateMaxUploadableFileSize({
      ...status.currentAllowances,
      pricePerTiBPerEpoch,
    })
    console.log(`maxUploadableFileSize {`)
    console.log(`  maxSizeBytes: ${maxUploadableFileSize.maxSizeBytes},`)
    console.log(`  maxSizeTiB: ${maxUploadableFileSize.maxSizeTiB},`)
    console.log(`  limitingFactor: '${maxUploadableFileSize.limitingFactor}',`)
    console.log(`  rateLimitTiB: ${maxUploadableFileSize.rateLimitTiB},`)
    console.log(`  lockupLimitTiB: ${maxUploadableFileSize.lockupLimitTiB}`)
    console.log(`}`)

    console.log(`max Duration For File Size ${maxDurationForFileSize.maxDurationDays}`)
    console.log(`maxUploadableFileSize ${formatStorageSize(makeStorageUnit(maxUploadableFileSize.maxSizeTiB, 'TiB'))}`)

    // === STORAGE DURATION ANALYSIS ===
    console.log('=== STORAGE DURATION ANALYSIS ===')

    const fileSizeDisplay = formatStorageSize(getStorageUnitBI(carSizeBytesBigInt))

    const formatDuration = (value: number): string => `${value.toFixed(2)} days`

    const { rateDurationDays, lockupDurationDays, maxDurationDays, limitingFactor } = maxDurationForFileSize

    console.log(`File size analyzed: ${fileSizeDisplay}`)
    console.log(`Rate-based duration: ${formatDuration(rateDurationDays)}`)
    console.log(`Lockup-based duration: ${formatDuration(lockupDurationDays)}`)
    console.log(`Actual duration: ${formatDuration(maxDurationDays)} (limited by ${limitingFactor})`)

    if (maxDurationDays >= 365) {
      console.log(`✅ Storage duration: ${(maxDurationDays / 365).toFixed(1)} years`)
    } else if (maxDurationDays >= 30) {
      console.log(`✅ Storage duration: ${(maxDurationDays / 30).toFixed(1)} months`)
    } else {
      console.log(`⚠️  Storage duration: ${maxDurationDays.toFixed(1)} days`)
    }

    // === VALIDATION CHECKS ===
    const monthlyPayment = required.rateAllowance * TIME_CONSTANTS.EPOCHS_PER_MONTH
    const totalDepositNeeded = required.lockupAllowance + monthlyPayment

    console.log('=== DEPOSIT CHECK ===')
    console.log(`Current deposit: ${formatUSDFC(status.depositedAmount)} USDFC`)
    console.log(`Total deposit needed: ${formatUSDFC(totalDepositNeeded)} USDFC`)
    console.log(
      `Comparison: ${status.depositedAmount} < ${totalDepositNeeded} = ${status.depositedAmount < totalDepositNeeded}`
    )

    console.log('=== RATE ALLOWANCE CHECK ===')
    console.log(`Current rate allowance: ${formatUSDFC(status.currentAllowances.rateAllowance)} USDFC/epoch`)
    console.log(`Required rate allowance: ${formatUSDFC(required.rateAllowance)} USDFC/epoch`)
    console.log(
      `Comparison: ${status.currentAllowances.rateAllowance} < ${required.rateAllowance} = ${status.currentAllowances.rateAllowance < required.rateAllowance}`
    )

    console.log('=== LOCKUP ALLOWANCE CHECK ===')
    console.log(`Current lockup allowance: ${formatUSDFC(status.currentAllowances.lockupAllowance)} USDFC`)
    console.log(`Required lockup allowance: ${formatUSDFC(required.lockupAllowance)} USDFC`)
    console.log(
      `Comparison: ${status.currentAllowances.lockupAllowance} < ${required.lockupAllowance} = ${status.currentAllowances.lockupAllowance < required.lockupAllowance}`
    )

    // === SUMMARY ===
    console.log('=== SUMMARY ===')
    const canUpload =
      status.depositedAmount >= totalDepositNeeded &&
      status.currentAllowances.rateAllowance >= required.rateAllowance &&
      status.currentAllowances.lockupAllowance >= required.lockupAllowance

    console.log(`Can upload: ${canUpload ? 'YES' : 'NO'}`)
    if (canUpload) {
      console.log(`✅ File can be uploaded successfully`)
    } else {
      console.log(`❌ File cannot be uploaded - check validation results above`)
    }
  } catch (error) {
    console.error('Error analyzing upload limits:', error)
    process.exitCode = 1
  }
}

// Main execution
async function main() {
  const filePath = process.argv[2]

  if (!filePath) {
    console.error('Usage: npx tsx src/debug/upload-size-limits.ts <file-path>')
    console.error('Example: npx tsx src/debug/upload-size-limits.ts ./test-file.car')
    process.exit(1)
  }
  try {
    await analyzeUploadLimits(filePath)
  } catch (error) {
    console.error('Error analyzing upload limits:', error)
    process.exitCode = 1
  } finally {
    await cleanupProvider(provider)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error)
}
