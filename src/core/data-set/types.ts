/**
 * Data Set Types
 *
 * Type definitions for working with Filecoin data-sets and pieces.
 * These types wrap synapse-sdk primitives to provide a consistent
 * interface for querying and enriching dataset information.
 *
 * @module core/data-set/types
 */

import type { EnhancedDataSetInfo, ProviderInfo, StorageContext } from '@filoz/synapse-sdk'
import type { Logger } from 'pino'
import type { Warning } from '../utils/types.js'

/**
 * Status of the piece, e.g. "pending removal", "active", "orphaned"
 *
 * - PENDING_REMOVAL: the piece is scheduled for deletion, but still showing on chain
 * - ACTIVE: the piece is active, onchain and known by the provider
 * - ONCHAIN_ORPHANED: the piece is not known by the provider, but still on chain
 * - OFFCHAIN_ORPHANED: the piece is known by the provider, but not on chain
 *
 * The orphaned states should not happen, but have been observed and should be logged and displayed to the user.
 */
export enum PieceStatus {
  ACTIVE = 'ACTIVE',
  PENDING_REMOVAL = 'PENDING_REMOVAL',
  ONCHAIN_ORPHANED = 'ONCHAIN_ORPHANED',
  OFFCHAIN_ORPHANED = 'OFFCHAIN_ORPHANED',
}

/**
 * Information about a single piece in a dataset
 */
export interface PieceInfo {
  /** Unique piece identifier (within dataset) */
  pieceId: number
  /** Piece Commitment (CommP) as string */
  pieceCid: string
  status: PieceStatus
  /** Root IPFS CID (from metadata, if available) */
  rootIpfsCid?: string
  /** Piece size in bytes (if available) */
  size?: number
  /** Additional piece metadata (key-value pairs) */
  metadata?: Record<string, string>
}

/**
 * Result from getting pieces for a dataset
 */
export interface DataSetPiecesResult {
  /** List of pieces in the dataset */
  pieces: PieceInfo[]
  /** Dataset ID these pieces belong to */
  dataSetId: number
  /** Total size of all pieces in bytes (sum of individual piece sizes) */
  totalSizeBytes?: bigint
  /** Non-fatal warnings encountered during retrieval */
  warnings?: Warning[]
}

/**
 * Summary information for a dataset
 *
 * Extends EnhancedDataSetInfo from synapse-sdk with optional provider enrichment.
 * This includes all fields needed by both the CLI and website:
 * - Rail IDs (pdpRailId, cdnRailId, cacheMissRailId)
 * - Contract details (commissionBps, pdpEndEpoch, cdnEndEpoch)
 * - Piece tracking (nextPieceId, currentPieceCount)
 * - Provider enrichment (optional provider field)
 * - Dataset metadata (inherited from EnhancedDataSetInfo.metadata - key-value pairs from WarmStorage)
 * - Filecoin-pin creation flag (indicates if created by filecoin-pin)
 * - Optional detailed information (pieces, metadata, size calculations, warnings)
 *
 * The dataSetId alias makes pdpVerifierDataSetId more discoverable.
 */
export interface DataSetSummary extends EnhancedDataSetInfo {
  /** PDP Verifier dataset ID (alias for pdpVerifierDataSetId) */
  dataSetId: number
  /** Provider information (enriched from getStorageInfo if available) */
  provider: ProviderInfo | undefined
  /** Total size in bytes (optional, calculated from piece sizes) */
  totalSizeBytes?: bigint
  /** Pieces in the dataset (optional, populated when fetching detailed info) */
  pieces?: PieceInfo[]
  /** Indicates if this dataset was created by filecoin-pin (has WITH_IPFS_INDEXING and source='filecoin-pin' metadata) */
  createdWithFilecoinPin: boolean
}

/**
 * Options for listing datasets
 */
export interface ListDataSetsOptions {
  /** Address to list datasets for (defaults to synapse client address) */
  address?: string
  /** Logger instance for debugging (optional) */
  logger?: Logger | undefined
  /**
   * Whether to get the provider details from the SP registry
   *
   * @default false
   */
  withProviderDetails?: boolean

  /**
   * Filter function to apply to the data sets before additional processing
   *
   * Note: The filter receives raw EnhancedDataSetInfo objects from the SDK
   * (with pdpVerifierDataSetId field) before transformation to DataSetSummary
   *
   * @param dataSet - Raw dataset from SDK storage.findDataSets()
   * @returns true to include the dataset, false to exclude it
   */
  filter?: undefined | ((dataSet: EnhancedDataSetInfo) => boolean)
}

/**
 * Options for getting pieces from a dataset
 */
export interface GetDataSetPiecesOptions {
  /** Whether to fetch and include piece metadata from WarmStorage */
  includeMetadata?: boolean
  /** Abort signal for cancellation */
  signal?: AbortSignal
  /** Logger instance for debugging (optional) */
  logger?: Logger | undefined
}

export type StorageContextWithDataSetId = StorageContext & { dataSetId: number }
