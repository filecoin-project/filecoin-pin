import type { Synapse, UploadCallbacks } from '@filoz/synapse-sdk'
import type { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import {
  checkAllowances,
  checkFILBalance,
  checkUSDFCBalance,
  type PaymentCapacityCheck,
  setMaxAllowances,
  validatePaymentCapacity,
  validatePaymentRequirements,
} from '../payments/index.js'
import type { SynapseService } from '../synapse/index.js'
import { type SynapseUploadResult, uploadToSynapse } from './synapse.js'

export type { SynapseUploadOptions, SynapseUploadResult } from './synapse.js'
export { getDownloadURL, getServiceURL, uploadToSynapse } from './synapse.js'

/**
 * Options for evaluating whether an upload can proceed.
 */
export type UploadReadinessProgressEvent =
  | { type: 'checking-balances' }
  | { type: 'checking-allowances' }
  | { type: 'configuring-allowances' }
  | { type: 'allowances-configured'; transactionHash?: string }
  | { type: 'validating-capacity' }

export interface UploadReadinessOptions {
  /** Initialized Synapse instance. */
  synapse: Synapse
  /** Size of the CAR file (bytes). */
  fileSize: number
  /**
   * Automatically configure allowances when they are missing.
   * Defaults to `true` to match current CLI/action behaviour.
   */
  autoConfigureAllowances?: boolean
  /** Optional callback for progress updates. */
  onProgress?: (event: UploadReadinessProgressEvent) => void
}

/**
 * Result of the payment readiness check prior to upload.
 */
export interface UploadReadinessResult {
  /** Overall status of the readiness check. */
  status: 'ready' | 'blocked'
  /** Gas + USDFC validation outcome. */
  validation: {
    isValid: boolean
    errorMessage?: string
    helpMessage?: string
  }
  /** FIL/gas balance status. */
  filStatus: Awaited<ReturnType<typeof checkFILBalance>>
  /** Wallet USDFC balance. */
  usdfcBalance: Awaited<ReturnType<typeof checkUSDFCBalance>>
  /** Allowance update information. */
  allowances: {
    needsUpdate: boolean
    updated: boolean
    transactionHash?: string | undefined
  }
  /** Capacity check from Synapse (present even when blocked). */
  capacity?: PaymentCapacityCheck
  /** Suggestions returned by the capacity check. */
  suggestions: string[]
}

type CapacityStatus = 'sufficient' | 'warning' | 'insufficient'

/**
 * Check readiness for uploading a CAR file.
 *
 * This performs the same validation chain previously used by the CLI/action:
 * 1. Ensure basic wallet requirements (FIL for gas, USDFC balance)
 * 2. Confirm or configure WarmStorage allowances
 * 3. Validate that the current deposit can cover the upload
 *
 * The function only mutates state when `autoConfigureAllowances` is enabled
 * (default), in which case it will call {@link setMaxAllowances} as needed.
 */
export async function checkUploadReadiness(options: UploadReadinessOptions): Promise<UploadReadinessResult> {
  const { synapse, fileSize, autoConfigureAllowances = true, onProgress } = options

  onProgress?.({ type: 'checking-balances' })

  const filStatus = await checkFILBalance(synapse)
  const usdfcBalance = await checkUSDFCBalance(synapse)

  const validation = validatePaymentRequirements(filStatus.hasSufficientGas, usdfcBalance, filStatus.isCalibnet)
  if (!validation.isValid) {
    return {
      status: 'blocked',
      validation,
      filStatus,
      usdfcBalance,
      allowances: {
        needsUpdate: false,
        updated: false,
      },
      suggestions: [],
    }
  }

  onProgress?.({ type: 'checking-allowances' })

  const allowanceStatus = await checkAllowances(synapse)
  let allowancesUpdated = false
  let allowanceTxHash: string | undefined

  if (allowanceStatus.needsUpdate && autoConfigureAllowances) {
    onProgress?.({ type: 'configuring-allowances' })
    const setResult = await setMaxAllowances(synapse)
    allowancesUpdated = true
    allowanceTxHash = setResult.transactionHash
    onProgress?.({ type: 'allowances-configured', transactionHash: allowanceTxHash })
  }

  onProgress?.({ type: 'validating-capacity' })

  const capacityCheck = await validatePaymentCapacity(synapse, fileSize)
  const capacityStatus = determineCapacityStatus(capacityCheck)

  if (capacityStatus === 'insufficient') {
    return {
      status: 'blocked',
      validation,
      filStatus,
      usdfcBalance,
      allowances: {
        needsUpdate: allowanceStatus.needsUpdate,
        updated: allowancesUpdated,
        transactionHash: allowanceTxHash,
      },
      capacity: capacityCheck,
      suggestions: capacityCheck.suggestions,
    }
  }

  return {
    status: 'ready',
    validation,
    filStatus,
    usdfcBalance,
    allowances: {
      needsUpdate: allowanceStatus.needsUpdate,
      updated: allowancesUpdated,
      transactionHash: allowanceTxHash,
    },
    capacity: capacityCheck,
    suggestions: capacityCheck.suggestions,
  }
}

function determineCapacityStatus(capacity: PaymentCapacityCheck): CapacityStatus {
  if (!capacity.canUpload) return 'insufficient'
  if (capacity.suggestions.length > 0) return 'warning'
  return 'sufficient'
}

export interface UploadExecutionOptions {
  /** Logger used for structured upload events. */
  logger: Logger
  /** Optional identifier to help correlate logs. */
  contextId?: string
  /** Optional callbacks mirroring Synapse SDK upload callbacks. */
  callbacks?: UploadCallbacks
}

export interface UploadExecutionResult extends SynapseUploadResult {
  /** Active network derived from the Synapse instance. */
  network: string
  /** Transaction hash from the piece-addition step (if available). */
  transactionHash?: string | undefined
}

/**
 * Execute the upload to Synapse, returning the same structured data used by the
 * CLI and GitHub Action.
 */
export async function executeUpload(
  synapseService: SynapseService,
  carData: Uint8Array,
  rootCid: CID,
  options: UploadExecutionOptions
): Promise<UploadExecutionResult> {
  const { logger, contextId, callbacks } = options
  let transactionHash: string | undefined

  const mergedCallbacks: UploadCallbacks = {
    onUploadComplete: (pieceCid) => {
      callbacks?.onUploadComplete?.(pieceCid)
    },
    onPieceAdded: (transaction) => {
      if (transaction?.hash) {
        transactionHash = transaction.hash
      }
      callbacks?.onPieceAdded?.(transaction)
    },
    onPieceConfirmed: (pieceIds) => {
      callbacks?.onPieceConfirmed?.(pieceIds)
    },
  }

  const uploadOptions: Parameters<typeof uploadToSynapse>[4] = {
    callbacks: mergedCallbacks,
  }
  if (contextId) {
    uploadOptions.contextId = contextId
  }

  const uploadResult = await uploadToSynapse(synapseService, carData, rootCid, logger, uploadOptions)

  const result: UploadExecutionResult = {
    ...uploadResult,
    network: synapseService.synapse.getNetwork(),
    transactionHash,
  }

  return result
}
