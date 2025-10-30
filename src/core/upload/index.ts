import type { Synapse } from '@filoz/synapse-sdk'
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
import { isSessionKeyMode, type SynapseService } from '../synapse/index.js'
import type { ProgressEvent, ProgressEventHandler } from '../utils/types.js'
import {
  type ValidateIPNIAdvertisementOptions,
  type ValidateIPNIProgressEvents,
  validateIPNIAdvertisement,
} from '../utils/validate-ipni-advertisement.js'
import { type SynapseUploadResult, type UploadProgressEvents, uploadToSynapse } from './synapse.js'

export type { SynapseUploadOptions, SynapseUploadResult, UploadProgressEvents } from './synapse.js'
export { getDownloadURL, getServiceURL, uploadToSynapse } from './synapse.js'

/**
 * Options for evaluating whether an upload can proceed.
 */
export type UploadReadinessProgressEvents =
  | ProgressEvent<'checking-balances'>
  | ProgressEvent<'checking-allowances'>
  | ProgressEvent<'configuring-allowances'>
  | ProgressEvent<'allowances-configured', { transactionHash?: string }>
  | ProgressEvent<'validating-capacity'>

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
  onProgress?: ProgressEventHandler<UploadReadinessProgressEvents>
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
  walletUsdfcBalance: Awaited<ReturnType<typeof checkUSDFCBalance>>
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
 *
 * **Session Key Authentication**: When using session key authentication,
 * `autoConfigureAllowances` is automatically disabled since payment operations
 * require the owner wallet to sign. Allowances must be configured separately
 * by the owner wallet before uploads can proceed.
 */
export async function checkUploadReadiness(options: UploadReadinessOptions): Promise<UploadReadinessResult> {
  const { synapse, fileSize, autoConfigureAllowances = true, onProgress } = options

  // Detect session key mode - payment operations cannot be performed
  const sessionKeyMode = isSessionKeyMode(synapse)
  const canConfigureAllowances = autoConfigureAllowances && !sessionKeyMode

  onProgress?.({ type: 'checking-balances' })

  const filStatus = await checkFILBalance(synapse)
  const walletUsdfcBalance = await checkUSDFCBalance(synapse)

  const validation = validatePaymentRequirements(filStatus.hasSufficientGas, walletUsdfcBalance, filStatus.isCalibnet)
  if (!validation.isValid) {
    return {
      status: 'blocked',
      validation,
      filStatus,
      walletUsdfcBalance,
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

  // Only try to configure allowances if not in session key mode
  if (allowanceStatus.needsUpdate && canConfigureAllowances) {
    onProgress?.({ type: 'configuring-allowances' })
    const setResult = await setMaxAllowances(synapse)
    allowancesUpdated = true
    allowanceTxHash = setResult.transactionHash
    onProgress?.({ type: 'allowances-configured', data: { transactionHash: allowanceTxHash } })
  }

  onProgress?.({ type: 'validating-capacity' })

  const capacityCheck = await validatePaymentCapacity(synapse, fileSize)
  const capacityStatus = determineCapacityStatus(capacityCheck)

  if (capacityStatus === 'insufficient') {
    return {
      status: 'blocked',
      validation,
      filStatus,
      walletUsdfcBalance,
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
    walletUsdfcBalance,
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
  /** Optional umbrella onProgress receiving child progress events. */
  onProgress?: ProgressEventHandler<(UploadProgressEvents | ValidateIPNIProgressEvents) & {}>
  /** Optional metadata to associate with the upload. */
  metadata?: Record<string, string>
  /**
   * Optional IPNI validation behaviour. When enabled (default), the upload flow will wait for the IPFS Root CID to be announced to IPNI.
   */
  ipniValidation?: {
    /**
     * Enable the IPNI validation wait.
     *
     * @default: true
     */
    enabled?: boolean
  } & Omit<ValidateIPNIAdvertisementOptions, 'onProgress'>
}

export interface UploadExecutionResult extends SynapseUploadResult {
  /** Active network derived from the Synapse instance. */
  network: string
  /** Transaction hash from the piece-addition step (if available). */
  transactionHash?: string | undefined
  /**
   * True if the IPFS Root CID was observed on filecoinpin.contact (IPNI).
   *
   * You should block any displaying, or attempting to access, of IPFS download URLs unless the IPNI validation is successful.
   */
  ipniValidated: boolean
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
  const { logger, contextId } = options
  let transactionHash: string | undefined
  let ipniValidationPromise: Promise<boolean> | undefined

  const onProgress: ProgressEventHandler<UploadProgressEvents | ValidateIPNIProgressEvents> = (event) => {
    switch (event.type) {
      case 'onPieceAdded': {
        // Begin IPNI validation as soon as the piece is added and parked in the data set
        if (options.ipniValidation?.enabled !== false && ipniValidationPromise == null) {
          try {
            const { enabled: _enabled, ...rest } = options.ipniValidation ?? {}
            ipniValidationPromise = validateIPNIAdvertisement(rootCid, {
              ...rest,
              logger,
            })
          } catch (error) {
            logger.error({ error }, 'Could not begin IPNI advertisement validation')
            ipniValidationPromise = Promise.resolve(false)
          }
        }
        if (event.data.txHash != null) {
          transactionHash = event.data.txHash
        }
        break
      }
      default: {
        break
      }
    }
    options.onProgress?.(event)
  }

  const uploadOptions: Parameters<typeof uploadToSynapse>[4] = {
    onProgress,
  }
  if (contextId) {
    uploadOptions.contextId = contextId
  }
  if (options.metadata) {
    uploadOptions.metadata = options.metadata
  }

  const uploadResult = await uploadToSynapse(synapseService, carData, rootCid, logger, uploadOptions)

  // Optionally validate IPNI advertisement of the root CID before returning
  let ipniValidated = false
  if (ipniValidationPromise != null) {
    try {
      ipniValidated = await ipniValidationPromise
    } catch (error) {
      logger.error({ error }, 'Could not validate IPNI advertisement')
      ipniValidated = false
    }
  }

  const result: UploadExecutionResult = {
    ...uploadResult,
    network: synapseService.synapse.getNetwork(),
    transactionHash,
    ipniValidated,
  }

  return result
}
