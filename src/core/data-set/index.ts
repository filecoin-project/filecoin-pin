/**
 * Data Set Core Module
 *
 * This module provides reusable functions for working with Filecoin data-sets
 * and pieces. It wraps synapse-sdk methods to provide a clean API that abstracts
 * away WarmStorageService and PDPServer implementation details.
 *
 * Key features:
 * - List datasets with optional provider enrichment
 * - Get pieces from a StorageContext with optional metadata
 * - Calculate actual storage across all data sets
 * - Graceful error handling with structured warnings
 * - Clean separation of concerns (follows SOLID principles)
 *
 * @module core/data-set
 */

export * from './calculate-actual-storage.js'
export * from './get-data-set-pieces.js'
export * from './get-detailed-data-set.js'
export * from './list-data-sets.js'
export * from './types.js'
