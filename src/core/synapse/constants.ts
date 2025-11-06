import { METADATA_KEYS } from '@filoz/synapse-sdk'

/**
 * Default metadata for Synapse data sets created by filecoin-pin
 */
export const DEFAULT_DATA_SET_METADATA = {
  [METADATA_KEYS.WITH_IPFS_INDEXING]: '', // Enable IPFS indexing for all data sets
  source: 'filecoin-pin', // Identify the source application
} as const

/**
 * Default configuration for creating storage contexts
 */
export const DEFAULT_STORAGE_CONTEXT_CONFIG = {
  withIpni: true, // Always filter for IPNI-enabled providers for IPFS indexing
  metadata: DEFAULT_DATA_SET_METADATA,
} as const
