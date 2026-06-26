import { METADATA_KEYS } from '@filoz/synapse-sdk'

/**
 * Application identifier used for Synapse namespace isolation and provenance detection.
 */
export const APPLICATION_SOURCE = 'filecoin-pin'

/**
 * Base metadata that opts a data set into IPFS indexing.
 * Injected whenever contexts are resolved by smart-select (not by explicit dataSetIds/contexts),
 * so metadataMatches() finds existing data sets using exact key-count matching.
 */
export const IPFS_INDEXED_METADATA = {
  [METADATA_KEYS.WITH_IPFS_INDEXING]: '',
} as const

/**
 * Default metadata for Synapse data sets created by filecoin-pin
 */
export const DEFAULT_DATA_SET_METADATA = {
  ...IPFS_INDEXED_METADATA,
  [METADATA_KEYS.SOURCE]: APPLICATION_SOURCE,
} as const

/**
 * Default number of copies (replication factor) used when the caller doesn't
 * specify --copies. Mirrors synapse-sdk's internal `DEFAULT_COPY_COUNT`
 * (`@filoz/synapse-sdk/src/storage/manager.ts`), which is not exported.
 * Keep in sync if upstream changes.
 */
export const DEFAULT_COPIES = 2
