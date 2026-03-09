import type { Chain, PDPProvider, Synapse } from '@filoz/synapse-sdk'
import { calibration, mainnet } from '@filoz/synapse-sdk'
import type { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import { DEVNET_CHAIN_ID } from '../../common/get-rpc-url.js'
import {
  checkAllowances,
  checkFILBalance,
  checkUSDFCBalance,
  type PaymentCapacityCheck,
  setMaxAllowances,
  validatePaymentCapacity,
  validatePaymentRequirements,
} from '../payments/index.js'
import { isSessionKeyMode } from '../synapse/index.js'
import type { ProgressEvent, ProgressEventHandler } from '../utils/types.js'
import {
  type ValidateIPNIProgressEvents,
  type WaitForIpniProviderResultsOptions,
  waitForIpniProviderResults,
} from '../utils/validate-ipni-advertisement.js'
import { type SynapseUploadResult, type UploadProgressEvents, uploadToSynapse } from './synapse.js'

export type { SynapseUploadOptions, SynapseUploadResult, UploadProgressEvents } from './synapse.js'
export { getDownloadURL, getServiceURL, uploadToSynapse } from './synapse.js'

/**
 * Derive a URL-safe network slug from the chain definition.
 * Falls back to the chain name for unknown chains.
 */
export function getNetworkSlug(chain: Chain): string {
  switch (chain.id) {
    case mainnet.id:
      return 'mainnet'
    case calibration.id:
      return 'calibration'
    case DEVNET_CHAIN_ID:
      return 'devnet'
    default:
      return chain.name
  }
}

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
  /** Optional metadata to associate with the upload (per-piece). */
  pieceMetadata?: Record<string, string>
  /**
   * Optional AbortSignal to cancel the upload operation.
   */
  signal?: AbortSignal
  /**
   * Optional IPNI validation behaviour. When enabled (default), the upload
   * flow will wait for the IPFS Root CID to be announced to IPNI.
   */
  ipniValidation?: {
    /**
     * Enable the IPNI validation wait.
     *
     * @default: true
     */
    enabled?: boolean
  } & Omit<WaitForIpniProviderResultsOptions, 'onProgress'>

  /** Number of storage copies to create (default determined by SDK). */
  count?: number

  /** Specific provider IDs to use. */
  providerIds?: bigint[]

  /** Specific data set IDs to use. */
  dataSetIds?: bigint[]

  /** Provider IDs to exclude from selection. */
  excludeProviderIds?: bigint[]

  /** Data set metadata applied when creating or matching contexts. */
  metadata?: Record<string, string>
}

export interface UploadExecutionResult extends SynapseUploadResult {
  /** Active network derived from the Synapse instance. */
  network: string
  /**
   * True if the IPFS Root CID was observed on filecoinpin.contact (IPNI).
   *
   * You should block any displaying, or attempting to access, of IPFS
   * download URLs unless the IPNI validation is successful.
   */
  ipniValidated: boolean
}

/**
 * Execute the upload to Synapse, returning the same structured data used by the
 * CLI and GitHub Action. Supports multi-copy uploads via the StorageManager.
 */
export async function executeUpload(
  synapse: Synapse,
  carData: Uint8Array,
  rootCid: CID,
  options: UploadExecutionOptions
): Promise<UploadExecutionResult> {
  options.signal?.throwIfAborted()

  const { logger, contextId } = options

  // Collect providers from `onProviderSelected` events for IPNI validation
  const selectedProviders: PDPProvider[] = []
  let ipniValidationPromise: Promise<boolean> | undefined

  const onProgress: ProgressEventHandler<UploadProgressEvents | ValidateIPNIProgressEvents> = (event) => {
    switch (event.type) {
      case 'onProviderSelected': {
        selectedProviders.push(event.data.provider)
        break
      }
      case 'onPiecesAdded': {
        // Begin IPNI validation on the first onPiecesAdded event
        if (options.ipniValidation?.enabled !== false && ipniValidationPromise == null) {
          const {
            enabled: _enabled,
            expectedProviders,
            signal: ipniSignal,
            ...restOptions
          } = options.ipniValidation ?? {}

          const validationOptions: WaitForIpniProviderResultsOptions = {
            ...restOptions,
            logger,
            signal: ipniSignal ?? options.signal,
          }

          if (options.onProgress != null) {
            validationOptions.onProgress = options.onProgress
          }

          // Use providers collected from selection events for IPNI validation
          if (expectedProviders != null) {
            validationOptions.expectedProviders = expectedProviders
          } else if (selectedProviders.length > 0) {
            validationOptions.expectedProviders = selectedProviders
          }

          ipniValidationPromise = waitForIpniProviderResults(rootCid, validationOptions).catch((error) => {
            validationOptions.signal?.throwIfAborted()
            logger.warn({ error }, 'IPNI provider results check was rejected')
            return false
          })
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
  if (options.pieceMetadata) {
    uploadOptions.pieceMetadata = options.pieceMetadata
  }
  if (options.signal != null) {
    uploadOptions.signal = options.signal
  }
  if (options.count != null) {
    uploadOptions.count = options.count
  }
  if (options.providerIds != null) {
    uploadOptions.providerIds = options.providerIds
  }
  if (options.dataSetIds != null) {
    uploadOptions.dataSetIds = options.dataSetIds
  }
  if (options.excludeProviderIds != null) {
    uploadOptions.excludeProviderIds = options.excludeProviderIds
  }
  if (options.metadata != null) {
    uploadOptions.metadata = options.metadata
  }

  const uploadResult = await uploadToSynapse(synapse, carData, rootCid, logger, uploadOptions)

  options.signal?.throwIfAborted()

  let ipniValidated = false
  if (ipniValidationPromise != null) {
    try {
      ipniValidated = await ipniValidationPromise
    } catch (error) {
      options.signal?.throwIfAborted()
      logger.error({ error }, 'Could not validate IPNI provider records')
      ipniValidated = false
    }
  }

  return {
    ...uploadResult,
    network: getNetworkSlug(synapse.chain),
    ipniValidated,
  }
}
