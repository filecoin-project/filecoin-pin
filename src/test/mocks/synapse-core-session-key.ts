import { type Mock, vi } from 'vitest'

/**
 * Mock of @filoz/synapse-core/session-key for tests: re-exports the real
 * permission constants and names, and overrides fromSecp256k1 so tests never
 * hit the network.
 */

const actual = await vi.importActual<typeof import('@filoz/synapse-core/session-key')>(
  '@filoz/synapse-core/session-key'
)

export const {
  CreateDataSetPermission,
  TerminateServicePermission,
  AddPiecesPermission,
  SchedulePieceRemovalsPermission,
  DefaultFwssPermissions,
  PermissionNames,
} = actual

const mockExpirations = Object.fromEntries(DefaultFwssPermissions.map((p) => [p, 0n]))

export const fromSecp256k1: Mock = vi.fn(() => ({
  syncExpirations: vi.fn().mockResolvedValue(undefined),
  hasPermission: vi.fn().mockReturnValue(true),
  expirations: mockExpirations,
  address: '0x0000000000000000000000000000000000000001',
}))
