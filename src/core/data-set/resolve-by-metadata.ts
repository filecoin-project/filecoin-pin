import type { Synapse } from '@filoz/synapse-sdk'
import type { Logger } from 'pino'
import { listDataSets } from './list-data-sets.js'

export type MetadataResolution =
  | { kind: 'no-match' }
  | { kind: 'matched'; dataSetIds: bigint[] }
  | { kind: 'too-many-matches'; matchedIds: bigint[]; expected: number }
  | { kind: 'too-few-matches'; matchedIds: bigint[]; expected: number }

export interface ResolveByMetadataOptions {
  expectedCopies: number
  logger?: Logger
}

/**
 * Find datasets whose on-chain metadata is a superset of `requestedMetadata`.
 *
 * synapse-sdk's smart-select requires exact key/value equality, so a partial
 * filter (e.g. `source=storacha-migration`) cannot route uploads to existing
 * datasets via the SDK alone. This performs the subset match locally and
 * returns dataset IDs the caller can pass as `dataSetIds` instead.
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
      /**
       * Require key presence on the dataset, not just value equality. Treating a
       * missing key as `''` would let `{ someKey: '' }` match datasets that don't
       * carry `someKey` at all, which violates the "requested keys are a subset
       * of dataset metadata" rule.
       */
      return entries.every(([key, value]) => key in metadata && metadata[key] === value)
    },
    ...(options.logger != null && { logger: options.logger }),
  })

  if (matched.length === 0) {
    return { kind: 'no-match' }
  }

  const matchedIds = matched.map((d) => d.dataSetId)

  if (matched.length > options.expectedCopies) {
    return { kind: 'too-many-matches', matchedIds, expected: options.expectedCopies }
  }

  if (matched.length < options.expectedCopies) {
    return { kind: 'too-few-matches', matchedIds, expected: options.expectedCopies }
  }

  return { kind: 'matched', dataSetIds: matchedIds }
}
