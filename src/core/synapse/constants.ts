import { METADATA_KEYS } from '@filoz/synapse-sdk'

/**
 * Default metadata for Synapse data sets created by filecoin-pin
 */
export const DEFAULT_DATA_SET_METADATA = {
  [METADATA_KEYS.WITH_IPFS_INDEXING]: '', // Enable IPFS indexing for all data sets
  source: 'filecoin-pin', // Identify the source application
} as const
