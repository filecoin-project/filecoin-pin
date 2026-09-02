import { AddPiecesPermission, SchedulePieceRemovalsPermission } from '@filoz/synapse-core/session-key'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authorizeSessionAddress, createSessionKey, revokeSessionAddress } from '../../core/session/index.js'
import { runSessionAuthorize } from '../../session/run-authorize.js'
import { runSessionCreate } from '../../session/run-create.js'
import { runSessionRevoke } from '../../session/run-revoke.js'

// The chain calls are mocked; these tests prove the parsed --scopes reach them.
vi.mock('../../core/session/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/session/index.js')>()
  const result = {
    ownerAddress: '0x1111111111111111111111111111111111111111',
    sessionAddress: '0x2222222222222222222222222222222222222222',
    registryAddress: '0x3333333333333333333333333333333333333333',
    permissions: [],
    expiry: 1790380800,
    validityDays: 10,
    txHash: `0x${'4'.repeat(64)}`,
    blockNumber: 1n,
    chainId: 314159,
    sessionPrivateKey: `0x${'5'.repeat(64)}`,
  }
  return {
    ...actual,
    authorizeSessionAddress: vi.fn(async () => result),
    revokeSessionAddress: vi.fn(async () => result),
    createSessionKey: vi.fn(async () => result),
  }
})
vi.mock('@clack/prompts', () => ({ confirm: vi.fn(async () => true), isCancel: vi.fn(() => false) }))
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return { ...actual, createWalletClient: vi.fn(() => ({})) }
})
vi.mock('../../utils/cli-helpers.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  createSpinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  isInteractive: vi.fn(() => false),
}))
vi.mock('../../utils/cli-logger.js', () => ({ log: { section: vi.fn(), line: vi.fn(), flush: vi.fn() } }))
vi.mock('../../session/resolve-network.js', () => ({
  resolveNetwork: vi.fn(async () => ({ chain: { name: 'calibration', id: 314159 }, transport: () => ({}) })),
}))

const owner = { privateKey: `0x${'a'.repeat(64)}`, validityDays: '10' }
const sessionAddress = '0x2222222222222222222222222222222222222222'

describe('--scopes reaches the chain call', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('authorize passes the parsed permissions, and omits them when --scopes is absent', async () => {
    await runSessionAuthorize({ ...owner, sessionAddress, scopes: 'addPieces' })
    expect(vi.mocked(authorizeSessionAddress).mock.calls[0]?.[1]).toMatchObject({ permissions: [AddPiecesPermission] })

    await runSessionAuthorize({ ...owner, sessionAddress })
    expect(vi.mocked(authorizeSessionAddress).mock.calls[1]?.[1]).not.toHaveProperty('permissions')
  })

  it('revoke passes the parsed permissions', async () => {
    await runSessionRevoke({ ...owner, sessionAddress, scopes: 'schedulePieceRemovals' })
    expect(vi.mocked(revokeSessionAddress).mock.calls[0]?.[1]).toMatchObject({
      permissions: [SchedulePieceRemovalsPermission],
    })
  })

  it('create passes the parsed permissions', async () => {
    await runSessionCreate({ ...owner, scopes: 'addPieces' })
    expect(vi.mocked(createSessionKey).mock.calls[0]?.[0]).toMatchObject({ permissions: [AddPiecesPermission] })
  })
})
