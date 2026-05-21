import { SIZE_CONSTANTS } from '@filoz/synapse-core/utils'

const PDP_LEAF_SIZE = Number(SIZE_CONSTANTS.BYTES_PER_LEAF)

/**
 * Pad raw size to the next multiple of the PDP leaf boundary.
 *
 * @param rawSizeBytes - The actual size in bytes
 * @returns Padded size aligned to PDP leaves
 */
export function padSizeToPDPLeaves(rawSizeBytes: number): number {
  return Math.ceil(rawSizeBytes / PDP_LEAF_SIZE) * PDP_LEAF_SIZE
}
