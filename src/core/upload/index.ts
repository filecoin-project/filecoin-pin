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
} from '../../synapse/payments.js'
import { validatePaymentRequirements } from '../payments/index.js'
import type { SynapseService } from '../../synapse/service.js'
import { type SynapseUploadResult, uploadToSynapse } from '../../synapse/upload.js'
import type { EventEmitter } from '../events/base.js'
import type { PaymentEvent, PaymentsCapacitySuccessEvent } from '../events/payment.js'
import type { UploadEvent } from '../events/upload.js'

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
  /** Optional event emitter for payment-related events. */
  emitter?: EventEmitter<PaymentEvent>
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
  const { synapse, fileSize, autoConfigureAllowances = true, emitter } = options

  emitter?.emit({ type: 'payments:validation:start' })

  const filStatus = await checkFILBalance(synapse)
  const usdfcBalance = await checkUSDFCBalance(synapse)

  const validation = validatePaymentRequirements(filStatus.hasSufficientGas, usdfcBalance, filStatus.isCalibnet)
  if (!validation.isValid) {
    emitter?.emit({
      type: 'payments:validation:failed',
      errorMessage: validation.errorMessage ?? 'Payment requirements not satisfied',
      ...(validation.helpMessage ? { helpMessage: validation.helpMessage } : {}),
    })
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

  emitter?.emit({ type: 'payments:validation:success' })

  emitter?.emit({ type: 'payments:allowances:start', stage: 'checking' })
  const allowanceStatus = await checkAllowances(synapse)
  let allowancesUpdated = false
  let allowanceTxHash: string | undefined

  if (allowanceStatus.needsUpdate && autoConfigureAllowances) {
    emitter?.emit({ type: 'payments:allowances:progress', stage: 'updating' })
    try {
      const setResult = await setMaxAllowances(synapse)
      allowancesUpdated = true
      allowanceTxHash = setResult.transactionHash
      emitter?.emit({ type: 'payments:allowances:progress', stage: 'updating', transactionHash: allowanceTxHash })
      emitter?.emit({
        type: 'payments:allowances:success',
        status: 'updated',
        transactionHash: allowanceTxHash,
      })
    } catch (error) {
      emitter?.emit({
        type: 'payments:allowances:failed',
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  } else if (allowanceStatus.needsUpdate) {
    emitter?.emit({
      type: 'payments:allowances:success',
      status: 'manual-required',
      reason: 'WarmStorage allowances must be configured manually.',
    })
  } else {
    emitter?.emit({ type: 'payments:allowances:success', status: 'updated' })
  }

  emitter?.emit({ type: 'payments:capacity:start' })
  const capacityCheck = await validatePaymentCapacity(synapse, fileSize)
  const capacityStatus: PaymentsCapacitySuccessEvent['status'] = determineCapacityStatus(capacityCheck)

  emitter?.emit({
    type: 'payments:capacity:success',
    status: capacityStatus,
    suggestions: capacityCheck.suggestions,
    issues: capacityCheck.issues,
  })

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

function determineCapacityStatus(capacity: PaymentCapacityCheck): PaymentsCapacitySuccessEvent['status'] {
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
  /** Optional event emitter for upload progress. */
  emitter?: EventEmitter<UploadEvent>
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
  const { logger, contextId, callbacks, emitter } = options
  let transactionHash: string | undefined

  emitter?.emit(contextId ? { type: 'upload:start', contextId } : { type: 'upload:start' })

  const mergedCallbacks: UploadCallbacks = {
    onUploadComplete: (pieceCid) => {
      callbacks?.onUploadComplete?.(pieceCid)
    },
    onPieceAdded: (transaction) => {
      if (transaction?.hash) {
        transactionHash = transaction.hash
      }
      emitter?.emit({
        type: 'upload:progress',
        ...(contextId ? { contextId } : {}),
        stage: 'piece-added',
        ...(transaction?.hash ? { transactionHash: transaction.hash } : {}),
      })
      callbacks?.onPieceAdded?.(transaction)
    },
    onPieceConfirmed: (pieceIds) => {
      emitter?.emit({
        type: 'upload:progress',
        ...(contextId ? { contextId } : {}),
        stage: 'piece-confirmed',
        pieceIds,
      })
      callbacks?.onPieceConfirmed?.(pieceIds)
    },
  }

  const uploadOptions: Parameters<typeof uploadToSynapse>[4] = {
    callbacks: mergedCallbacks,
  }
  if (contextId) {
    uploadOptions.contextId = contextId
  }

  try {
    const uploadResult = await uploadToSynapse(synapseService, carData, rootCid, logger, uploadOptions)

    const result: UploadExecutionResult = {
      ...uploadResult,
      network: synapseService.synapse.getNetwork(),
      transactionHash,
    }

    emitter?.emit({
      type: 'upload:success',
      ...(contextId ? { contextId } : {}),
      pieceCid: result.pieceCid,
      dataSetId: result.dataSetId,
      network: result.network,
      ...(typeof result.pieceId === 'number' ? { pieceId: result.pieceId } : {}),
    })

    return result
  } catch (error) {
    emitter?.emit({
      type: 'upload:failed',
      ...(contextId ? { contextId } : {}),
      error,
    })
    throw error
  }
}
