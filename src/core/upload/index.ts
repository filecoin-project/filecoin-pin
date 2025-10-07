import type { Synapse, UploadCallbacks } from '@filoz/synapse-sdk'
import type { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import { validatePaymentRequirements } from '../../payments/setup.js'
import {
  checkAllowances,
  checkFILBalance,
  checkUSDFCBalance,
  type PaymentCapacityCheck,
  setMaxAllowances,
  validatePaymentCapacity,
} from '../../synapse/payments.js'
import type { SynapseService } from '../../synapse/service.js'
import { type SynapseUploadResult, uploadToSynapse } from '../../synapse/upload.js'

/**
 * Options for evaluating whether an upload can proceed.
 */
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
  const { synapse, fileSize, autoConfigureAllowances = true } = options

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

  const allowanceStatus = await checkAllowances(synapse)
  let allowancesUpdated = false
  let allowanceTxHash: string | undefined

  if (allowanceStatus.needsUpdate && autoConfigureAllowances) {
    const setResult = await setMaxAllowances(synapse)
    allowancesUpdated = true
    allowanceTxHash = setResult.transactionHash
  }

  const capacityCheck = await validatePaymentCapacity(synapse, fileSize)
  if (!capacityCheck.canUpload) {
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

  return {
    ...uploadResult,
    network: synapseService.synapse.getNetwork(),
    transactionHash,
  }
}
