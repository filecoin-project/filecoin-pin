import type { FilecoinChain, PDPProvider, PieceCID, Synapse } from '@filoz/synapse-sdk'
import { calibration, mainnet } from '@filoz/synapse-sdk'
import type { StorageContext } from '@filoz/synapse-sdk/storage'
import type { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import { DEVNET_CHAIN_ID } from '../../common/constants.js'
import {
  checkAllowances,
  checkFILBalance,
  checkUSDFCBalance,
  getDepositedBalance,
  getUsdfcAcquisitionHelpMessage,
  type PaymentCapacityCheck,
  setMaxAllowances,
  validatePaymentCapacity,
  validatePaymentRequirements,
} from '../payments/index.js'
import { isSessionKeyMode } from '../synapse/index.js'
import { recordUploadResult } from '../telemetry/index.js'
import type { ProgressEvent, ProgressEventHandler } from '../utils/types.js'
import {
  type IndexingConfirmationProgressEvents,
  type WaitForIndexingConfirmationOptions,
  waitForIndexingConfirmation,
} from '../utils/validate-ipni-advertisement.js'
import {
  type SynapseUploadData,
  type SynapseUploadResult,
  type UploadProgressEvents,
  uploadToSynapse,
} from './synapse.js'

export type { SynapseUploadData, SynapseUploadOptions, SynapseUploadResult, UploadProgressEvents } from './synapse.js'
export { getDownloadURL, getServiceURL, uploadToSynapse } from './synapse.js'

/**
 * Derive a URL-safe network slug from the chain definition.
 * Falls back to the chain name for unknown chains.
 */
export function getNetworkSlug(chain: FilecoinChain): string {
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
  | ProgressEvent<'checkingBalances'>
  | ProgressEvent<'checkingAllowances'>
  | ProgressEvent<'configuringAllowances'>
  | ProgressEvent<'allowancesConfigured', { transactionHash?: string }>
  | ProgressEvent<'validatingCapacity'>

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
  /** Wallet validation outcome (gas, or no USDFC anywhere). */
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
 * 1. Ensure the wallet has enough FIL for gas
 * 2. Ensure the account holds USDFC somewhere (wallet or deposit)
 * 3. Confirm or configure WarmStorage allowances
 * 4. Validate that the current deposit can cover the upload
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

  onProgress?.({ type: 'checkingBalances' })

  const [filStatus, walletUsdfcBalance, depositedBalance] = await Promise.all([
    checkFILBalance(synapse),
    checkUSDFCBalance(synapse),
    getDepositedBalance(synapse),
  ])

  // Validate against total USDFC (wallet + deposited): uploads pay from the
  // deposit, so an account holding all its USDFC as deposits is funded, while
  // an account with no USDFC anywhere can never upload and must be blocked
  // here, before any allowance transaction spends gas. Whether the deposit
  // covers this file is checked below by validatePaymentCapacity.
  const validation = validatePaymentRequirements(
    filStatus.balance,
    walletUsdfcBalance + depositedBalance,
    filStatus.isCalibnet
  )
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

  onProgress?.({ type: 'checkingAllowances' })

  const allowanceStatus = await checkAllowances(synapse)
  let allowancesUpdated = false
  let allowanceTxHash: string | undefined

  // Only try to configure allowances if not in session key mode
  if (allowanceStatus.needsUpdate && canConfigureAllowances) {
    onProgress?.({ type: 'configuringAllowances' })
    const setResult = await setMaxAllowances(synapse)
    allowancesUpdated = true
    allowanceTxHash = setResult.transactionHash
    onProgress?.({ type: 'allowancesConfigured', data: { transactionHash: allowanceTxHash } })
  }

  onProgress?.({ type: 'validatingCapacity' })

  const capacityCheck = await validatePaymentCapacity(synapse, fileSize) // issue #599: validatePaymentCapacity also calls checkAndSetAllowances internally, making autoConfigureAllowances: false ineffective
  const capacityStatus = determineCapacityStatus(capacityCheck)

  if (capacityStatus === 'insufficient') {
    // Suggesting a deposit is useless when the wallet cannot cover the
    // shortfall, so include how to acquire USDFC alongside the suggestion.
    // Suggestions render one bullet per entry, so split multi-line help.
    if (walletUsdfcBalance < (capacityCheck.issues.insufficientDeposit ?? 0n)) {
      const helpLines = getUsdfcAcquisitionHelpMessage(filStatus.isCalibnet)
        .split('\n')
        .map((line) => line.trim())
      capacityCheck.suggestions.push(...helpLines)
    }
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
  onProgress?: ProgressEventHandler<(UploadProgressEvents | IndexingConfirmationProgressEvents) & {}>
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
  } & Omit<WaitForIndexingConfirmationOptions, 'onProgress'>

  /** Number of storage copies to create (default determined by SDK). */
  copies?: number

  /**
   * Pre-created storage contexts to use directly. When provided, the SDK
   * skips provider selection and uses these contexts as-is. Each context
   * carries its provider binding and (optional) data set ID.
   *
   * Mutually exclusive with `providerIds`, `dataSetIds`, and `copies`.
   *
   * @example Upload using a pre-resolved context
   * ```ts
   * const [ctx] = await synapse.storage.createContexts({ providerIds: [9n] })
   * executeUpload(synapse, carData, rootCid, { contexts: [ctx], logger, ... })
   * ```
   */
  contexts?: StorageContext[]

  /**
   * Specific provider IDs to upload to. The SDK resolves or creates data sets
   * on each provider automatically. Mutually exclusive with `dataSetIds` and
   * `contexts`.
   *
   * This is the recommended way to target specific providers. Do not call
   * `createContext()` to resolve data sets first. Pass provider IDs here
   * and the SDK handles the rest.
   *
   * @example Upload to two specific providers
   * ```ts
   * executeUpload(synapse, carData, rootCid, { providerIds: [4n, 9n], ... })
   * ```
   */
  providerIds?: bigint[]

  /**
   * Specific existing data set IDs to target. Mutually exclusive with
   * `providerIds` and `contexts`.
   *
   * Use only when resuming into a known data set from a prior operation.
   * For first-time uploads to specific providers, use `providerIds` instead.
   */
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
   * True if the IPNI indexer confirmed the piece's advertisement(s) as indexed and
   * the IPFS Root CID was confirmed present on the indexer.
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
  carData: SynapseUploadData,
  rootCid: CID,
  options: UploadExecutionOptions
): Promise<UploadExecutionResult> {
  options.signal?.throwIfAborted()

  const { logger, contextId } = options

  if (options.contexts != null) {
    const conflicting = [
      options.providerIds != null && 'providerIds',
      options.dataSetIds != null && 'dataSetIds',
      options.copies != null && 'copies',
      options.excludeProviderIds != null && 'excludeProviderIds',
    ].filter(Boolean)
    if (conflicting.length > 0) {
      throw new Error(
        `Cannot combine 'contexts' with ${conflicting.join(', ')}. ` +
          'Pre-created contexts fully determine provider targeting and copy count.'
      )
    }
  } else if (options.providerIds != null && options.dataSetIds != null) {
    throw new Error(
      "Cannot specify both 'providerIds' and 'dataSetIds'. " +
        'To target specific providers, use providerIds (recommended). ' +
        'Use dataSetIds only when resuming into a known dataset from a prior operation.'
    )
  }

  // pieceCid is identical across providers for the same upload, so any `stored` event works.
  // contexts carry their provider directly — no providerSelected event fires for them.
  const selectedProviders: PDPProvider[] = options.contexts?.map((context) => context.provider) ?? []
  let pieceCidForValidation: PieceCID | undefined
  let ipniValidationPromise: Promise<boolean> | undefined

  const emitProgress: ProgressEventHandler<UploadProgressEvents | IndexingConfirmationProgressEvents> = (event) => {
    switch (event.type) {
      case 'providerSelected': {
        selectedProviders.push(event.data.provider)
        break
      }
      case 'stored': {
        pieceCidForValidation ??= event.data.pieceCid
        break
      }
      case 'piecesAdded': {
        // Begin indexing confirmation on the first piecesAdded event
        if (options.ipniValidation?.enabled !== false && ipniValidationPromise == null) {
          if (pieceCidForValidation == null) {
            logger.warn('piecesAdded fired before stored; skipping indexing confirmation (no pieceCid to poll)')
            break
          }
          const {
            enabled: _enabled,
            expectedProviders,
            signal: ipniSignal,
            ...restOptions
          } = options.ipniValidation ?? {}

          const validationOptions: WaitForIndexingConfirmationOptions = {
            ...restOptions,
            logger,
            signal: ipniSignal ?? options.signal,
          }

          if (options.onProgress != null) {
            validationOptions.onProgress = options.onProgress
          }

          // Use providers collected from selection events for indexing confirmation
          if (expectedProviders != null) {
            validationOptions.expectedProviders = expectedProviders
          } else if (selectedProviders.length > 0) {
            validationOptions.expectedProviders = selectedProviders
          }

          ipniValidationPromise = waitForIndexingConfirmation(rootCid, pieceCidForValidation, validationOptions).catch(
            (error) => {
              validationOptions.signal?.throwIfAborted()
              logger.warn({ error }, 'Indexing confirmation check was rejected')
              return false
            }
          )
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
    onProgress: emitProgress,
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
  if (options.contexts != null) {
    // Contexts carry their own provider/dataset bindings; no other targeting needed
    uploadOptions.contexts = options.contexts
  } else {
    if (options.copies != null) {
      uploadOptions.copies = options.copies
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
  }
  if (options.metadata != null) {
    uploadOptions.metadata = options.metadata
  }

  const uploadResult = await uploadToSynapse(synapse, carData, rootCid, logger, uploadOptions)

  const network = getNetworkSlug(synapse.chain)
  recordUploadResult(uploadResult, network)

  options.signal?.throwIfAborted()

  let ipniValidated = false
  if (ipniValidationPromise != null) {
    try {
      ipniValidated = await ipniValidationPromise
    } catch (error) {
      options.signal?.throwIfAborted()
      logger.error({ error }, 'Could not confirm indexing')
      ipniValidated = false
    }
  }

  return {
    ...uploadResult,
    network,
    ipniValidated,
  }
}
