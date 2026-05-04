import { METADATA_KEYS } from '@filoz/synapse-sdk'

/**
 * Application identifier used for Synapse namespace isolation and provenance detection.
 */
export const APPLICATION_SOURCE = 'filecoin-pin'

/**
 * Default metadata for Synapse data sets created by filecoin-pin
 */
export const DEFAULT_DATA_SET_METADATA = {
  [METADATA_KEYS.WITH_IPFS_INDEXING]: '', // Enable IPFS indexing for all data sets
  [METADATA_KEYS.SOURCE]: APPLICATION_SOURCE, // Identify the source application
} as const

/**
 * Default number of copies (replication factor) used when the caller doesn't
 * specify --copies. Mirrors synapse-sdk's internal `DEFAULT_COPY_COUNT`
 * (`@filoz/synapse-sdk/src/storage/manager.ts`), which is not exported.
 * Keep in sync if upstream changes.
 */
export const DEFAULT_COPIES = 2
