import { vi } from 'vitest'

/**
 * Mock implementation of @filoz/synapse-core/session-key for testing
 *
 * fromSecp256k1 returns a minimal SessionKey-shaped object with a no-op
 * syncExpirations so tests never hit the real network.
 */
export const fromSecp256k1 = vi.fn(() => ({
  syncExpirations: vi.fn().mockResolvedValue(undefined),
}))
