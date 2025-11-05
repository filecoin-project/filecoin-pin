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

/**
 * Information about a single piece in a dataset
 */
export interface PieceInfo {
  /** Unique piece identifier (within dataset) */
  pieceId: number
  /** Piece Commitment (CommP) as string */
  pieceCid: string
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
  /** Non-fatal warnings encountered during retrieval */
  warnings?: Warning[]
}

/**
 * Structured warning for non-fatal issues
 */
export interface Warning {
  /** Machine-readable warning code (e.g., 'METADATA_FETCH_FAILED') */
  code: string
  /** Human-readable warning message */
  message: string
  /** Additional context data (e.g., { pieceId: 123, dataSetId: 456 }) */
  context?: Record<string, unknown>
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
 *
 * The dataSetId alias makes pdpVerifierDataSetId more discoverable.
 */
export interface DataSetSummary extends EnhancedDataSetInfo {
  /** PDP Verifier dataset ID (alias for pdpVerifierDataSetId) */
  dataSetId: number
  /** Provider information (enriched from getStorageInfo if available) */
  provider: ProviderInfo | undefined
}

/**
 * Options for listing datasets
 */
export interface ListDataSetsOptions {
  /** Address to list datasets for (defaults to synapse client address) */
  address?: string
  /** Logger instance for debugging (optional) */
  logger?: Logger
}

/**
 * Options for getting pieces from a dataset
 */
export interface GetDataSetPiecesOptions {
  /** Whether to fetch and include piece metadata from WarmStorage */
  includeMetadata?: boolean
  /** Batch size for pagination (default: 100) */
  batchSize?: number
  /** Abort signal for cancellation */
  signal?: AbortSignal
  /** Synapse instance (required if includeMetadata is true) */
  synapse?: import('@filoz/synapse-sdk').Synapse
  /** Logger instance for debugging (optional) */
  logger?: Logger
}

export type StorageContextWithDataSetId = StorageContext & { dataSetId: number }
