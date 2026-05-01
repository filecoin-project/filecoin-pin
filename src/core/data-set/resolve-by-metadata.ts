/**
 * Resolve user-supplied dataset metadata to existing dataset IDs via local
 * subset matching, sidestepping synapse-sdk's exact-equality `metadataMatches`.
 *
 * @module core/data-set/resolve-by-metadata
 */

import type { Synapse } from '@filoz/synapse-sdk'
import type { Logger } from 'pino'
import { listDataSets } from './list-data-sets.js'

export type MetadataResolution =
  | { kind: 'no-match' }
  | { kind: 'matched'; dataSetIds: bigint[] }
  | { kind: 'ambiguous'; matchedIds: bigint[]; expected: number }

export interface ResolveByMetadataOptions {
  expectedCopies: number
  logger?: Logger
}

/**
 * Find datasets whose on-chain metadata is a superset of `requestedMetadata`.
 *
 * The synapse-sdk smart-select path requires exact key/value equality, so callers
 * who pass a partial metadata filter (e.g. `source=storacha-migration`) cannot
 * route uploads to existing datasets via the SDK alone. This resolver performs
 * the subset match locally and returns dataset IDs the caller can pass as
 * `dataSetIds` instead.
 *
 * Outcomes:
 * - `no-match`: caller should fall back to current behavior (SDK creates a new
 *   dataset tagged with the requested metadata).
 * - `matched`: caller should use `dataSetIds` and drop the metadata from the
 *   upload request.
 * - `ambiguous`: caller should error and ask the user to narrow the filter or
 *   pass `--data-set-ids` explicitly.
 */
export async function resolveDataSetIdsByMetadata(
  synapse: Synapse,
  requestedMetadata: Record<string, string>,
  options: ResolveByMetadataOptions
): Promise<MetadataResolution> {
  const entries = Object.entries(requestedMetadata)
  if (entries.length === 0) {
    return { kind: 'no-match' }
  }

  const matched = await listDataSets(synapse, {
    withProviderDetails: false,
    filter: (dataSet) => {
      if (!dataSet.isLive) {
        return false
      }
      const metadata = dataSet.metadata
      if (metadata == null) {
        return false
      }
      // Require key presence on the dataset, not just value equality. Treating a
      // missing key as `''` would let `{ someKey: '' }` match datasets that don't
      // carry `someKey` at all, which violates the "requested keys are a subset
      // of dataset metadata" rule.
      return entries.every(([key, value]) => key in metadata && metadata[key] === value)
    },
    ...(options.logger != null && { logger: options.logger }),
  })

  if (matched.length === 0) {
    return { kind: 'no-match' }
  }

  if (matched.length !== options.expectedCopies) {
    return {
      kind: 'ambiguous',
      matchedIds: matched.map((d) => d.dataSetId),
      expected: options.expectedCopies,
    }
  }

  return { kind: 'matched', dataSetIds: matched.map((d) => d.dataSetId) }
}
