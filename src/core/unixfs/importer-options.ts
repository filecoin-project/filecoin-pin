/**
 * UnixFS importer options aligned with IPIP-499 unixfs-v1-2025 profile.
 *
 * The profile is consumed by ipfs-unixfs-importer (via @helia/unixfs) and
 * forces block-bytes HAMT shard estimation, 1 MiB chunks, raw leaves,
 * CIDv1, and 1024-link DAG width — matching Kubo / Boxo defaults under
 * the same profile, so CIDs reproduce across implementations.
 *
 * Spec: https://github.com/ipfs/specs/pull/499
 */

import type { AddOptions } from '@helia/unixfs'

export const UNIXFS_PROFILE = 'unixfs-v1-2025' as const

export const importerOptions: AddOptions = {
  profile: UNIXFS_PROFILE,
}
