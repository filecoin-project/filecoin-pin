import { PDP_LEAF_SIZE } from './constants.js'

/**
 * Pad raw size to the next multiple of 32 bytes
 *
 * @param rawSizeBytes - The actual size in bytes
 * @returns Padded size (next multiple of 32)
 */
export function padSizeToPDPLeaves(rawSizeBytes: number): number {
  return Math.ceil(rawSizeBytes / PDP_LEAF_SIZE) * PDP_LEAF_SIZE
}
