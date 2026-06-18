import { type Mock, vi } from 'vitest'

/**
 * Mock implementation of @filoz/synapse-core/session-key for testing
 *
 * Exports real permission constants (hardcoded to avoid circular mock imports)
 * and overrides fromSecp256k1 so tests never hit the real network.
 */

export const CreateDataSetPermission = '0x25ebf20299107c91b4624d5bac3a16d32cabf0db23b450ee09ab7732983b1dc9'
export const DeleteDataSetPermission = '0xb5d6b3fc97881f05e96958136ac09d7e0bc7cbf17ea92fce7c431d88132d2b58'
export const AddPiecesPermission = '0x954bdc254591a7eab1b73f03842464d9283a08352772737094d710a4428fd183'
export const SchedulePieceRemovalsPermission = '0x5415701e313bb627e755b16924727217bb356574fe20e7061442c200b0822b22'

export const DefaultFwssPermissions = [
  CreateDataSetPermission,
  DeleteDataSetPermission,
  AddPiecesPermission,
  SchedulePieceRemovalsPermission,
]

const mockExpirations = Object.fromEntries(DefaultFwssPermissions.map((p) => [p, 0n]))

export const fromSecp256k1: Mock = vi.fn(() => ({
  syncExpirations: vi.fn().mockResolvedValue(undefined),
  hasPermission: vi.fn().mockReturnValue(true),
  expirations: mockExpirations,
  address: '0x0000000000000000000000000000000000000001',
}))
