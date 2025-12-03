/**
 * Helper: createStorageContextFromDataSetId
 *
 * Optimized helper to create a StorageContext for an existing dataset ID without
 * triggering the expensive "scan all client datasets" hotpath.
 *
 * This is a workaround for https://github.com/FilOzone/synapse-sdk/issues/435
 * until https://github.com/FilOzone/synapse-sdk/pull/438 is merged and published.
 *
 * Benefits:
 *  - Reuses Synapse's existing WarmStorageService (no extra initialization)
 *  - Only fetches data for the single dataset needed (~5-6 RPC calls vs 1500+)
 *  - Validates ownership, isLive, and isManaged
 *
 * TODO: Replace with synapse.storage.createContextFromDataSetId() once PR #438 is published
 */

import type { Synapse, WarmStorageService } from '@filoz/synapse-sdk'
import { StorageContext } from '@filoz/synapse-sdk'
import { type ProviderInfo, SPRegistryService } from '@filoz/synapse-sdk/sp-registry'
import type { Logger } from 'pino'
import { DEFAULT_DATA_SET_METADATA, DEFAULT_STORAGE_CONTEXT_CONFIG } from './index.js'
export type StorageContextHelperResult = {
  storage: StorageContext
  providerInfo: ProviderInfo
}

export type CreateStorageContextFromDataSetIdOptions = {
  /**
   * Whether to check if the provider is approved or not. We default to false here because for many read operations,
   * we might want to re-use the dataset even if it's not owned by an approved provider.
   * @default false
   */
  checkProviderApproval?: boolean
}

/**
 * Create a StorageContext for an existing dataSetId without scanning all datasets.
 */
export async function createStorageContextFromDataSetId(
  synapse: Synapse,
  dataSetId: number,
  options?: CreateStorageContextFromDataSetIdOptions
): Promise<StorageContextHelperResult> {
  const { checkProviderApproval = false } = options ?? {}
  // Access Synapse's internal WarmStorageService (avoids creating a new one)
  // @ts-expect-error - Accessing private _warmStorageService temporarily until SDK is updated
  const warmStorage = synapse.storage._warmStorageService
  if (!warmStorage) {
    throw new Error('WarmStorageService not available on Synapse instance')
  }

  // Get basic dataset info and validate in parallel
  const [dataSetInfo] = await Promise.all([warmStorage.getDataSet(dataSetId), warmStorage.validateDataSet(dataSetId)])

  // Verify ownership
  const signerAddress = await synapse.getClient().getAddress()
  if (dataSetInfo.payer.toLowerCase() !== signerAddress.toLowerCase()) {
    throw new Error(`Data set ${dataSetId} is not owned by ${signerAddress} (owned by ${dataSetInfo.payer})`)
  }

  const registryAddress = warmStorage.getServiceProviderRegistryAddress()
  const spRegistry = new SPRegistryService(synapse.getProvider(), registryAddress)

  if (checkProviderApproval) {
    /**
     * If asked to check provider approval and it's not an approved provider, we're going to throw an error.
     */
    const isProviderApproved = await warmStorage.isProviderIdApproved(dataSetInfo.providerId)
    if (!isProviderApproved) {
      throw new Error(`Data set ${dataSetId} is not owned by an approved provider`)
    }
  }

  // Get provider info and metadata in parallel
  const [providerInfo, dataSetMetadata] = await Promise.all([
    spRegistry.getProvider(dataSetInfo.providerId),
    warmStorage.getDataSetMetadata(dataSetId),
  ])

  if (providerInfo == null) {
    throw new Error(`Unable to resolve provider info for data set ${dataSetId} and provider ${dataSetInfo.providerId}`)
  }

  // Construct storage context directly
  const withCDN = dataSetInfo.cdnRailId > 0
  const storageContext = new StorageContext(synapse, warmStorage, providerInfo, dataSetId, { withCDN }, dataSetMetadata)

  return {
    storage: storageContext,
    providerInfo,
  }
}

export type CreateNewStorageContextOptions = {
  providerId?: number
  providerAddress?: string
  warmStorage?: WarmStorageService
  spRegistry?: SPRegistryService
  logger?: Logger
}

/**
 * Create a StorageContext configured for creating a brand new dataset without scanning all
 * existing datasets. Provider selection favors explicit overrides and otherwise randomly selects
 * an active provider that exposes a PDP endpoint.
 */
export async function createStorageContextForNewDataSet(
  synapse: Synapse,
  options: CreateNewStorageContextOptions = {}
): Promise<StorageContextHelperResult> {
  // @ts-expect-error - Accessing private _warmStorageService temporarily until SDK is updated
  const warmStorage = options.warmStorage ?? synapse.storage._warmStorageService
  if (!warmStorage) {
    throw new Error('WarmStorageService not available on Synapse instance')
  }

  const registryAddress = warmStorage.getServiceProviderRegistryAddress()
  const spRegistry = options.spRegistry ?? new SPRegistryService(synapse.getProvider(), registryAddress)

  const providerInfo = await getApprovedProviderInfo(warmStorage, spRegistry, options.providerId, options.logger)

  const mergedMetadata = { ...DEFAULT_DATA_SET_METADATA }

  const storageOptions = {
    ...DEFAULT_STORAGE_CONTEXT_CONFIG,
    metadata: mergedMetadata,
  }

  const storageContext = new StorageContext(
    synapse,
    warmStorage,
    providerInfo,
    undefined,
    storageOptions,
    mergedMetadata
  )

  return {
    storage: storageContext,
    providerInfo,
  }
}

/**
 * getApprovedProviderInfo should only be called from createStorageContextForNewDataSet, which is only called with a providerId if a user has explicitly provided one as a query parameter.
 */
async function getApprovedProviderInfo(
  warmStorage: WarmStorageService,
  spRegistry: SPRegistryService,
  providerId?: number,
  logger?: Logger
): Promise<ProviderInfo> {
  let providerInfo: ProviderInfo | null = null

  if (providerId != null) {
    // if given a providerId, check if it is approved and log a warning if it's not an approved provider.
    const isProviderApproved = await warmStorage.isProviderIdApproved(providerId)
    if (!isProviderApproved) {
      logger?.warn(
        { providerId },
        `Presuming given providerId ${providerId} is a queryParam and allowing creation to continue with a non-approved provider`
      )
    }
    providerInfo = await spRegistry.getProvider(providerId)
  } else {
    // otherwise, get all approved provider ids and randomly select one.
    const approvedProviderIds = await warmStorage.getApprovedProviderIds()

    // select a random approved provider id
    const randomApprovedProviderId = pickRandom(approvedProviderIds)
    providerInfo = await spRegistry.getProvider(randomApprovedProviderId)
  }

  if (providerInfo == null) {
    throw new Error(`Unable to resolve an approved storage provider for new data set creation`)
  }

  return providerInfo
}

function pickRandom<T>(providerIds: T[]): T {
  if (providerIds.length === 0) throw new Error('No approved storage providers available for new data set creation')

  return providerIds[Math.floor(Math.random() * providerIds.length)] as T
}
export default createStorageContextFromDataSetId
