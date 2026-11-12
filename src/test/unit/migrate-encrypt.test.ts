import { keyspaceKeys as deriveGroupKey } from '@filoz/keysmith'
import type { Synapse } from '@filoz/synapse-sdk'
import { describe, expect, it, vi } from 'vitest'
import { OWNER_WALLET_REQUIRED, ownerGroupKey } from '../../common/group-key.js'
import type { SynapseSetupConfig } from '../../core/synapse/index.js'
import { migrateGroupKey } from '../../migrate/migrate.js'
import { GROUP_KEY, OWNER } from '../fixtures/group-key-grants.js'

const { mockListDataSets } = vi.hoisted(() => ({ mockListDataSets: vi.fn() }))
vi.mock('../../core/data-set/list-data-sets.js', () => ({ listDataSets: mockListDataSets }))

const OLDER = '0x00112233445566778899aabbccddeeff'
const NO_SESSION = {} as SynapseSetupConfig
const asOwner = { client: { account: OWNER }, chain: { id: 314159 } } as unknown as Synapse

describe('migrateGroupKey', () => {
  it('picks the group key add --encrypt picks: the oldest valid one on chain', async () => {
    const { commitment } = await deriveGroupKey(OWNER, { owner: OWNER.address, keyspace: OLDER })
    mockListDataSets.mockResolvedValue([
      { dataSetId: 9n, isLive: true, metadata: { 'foc/ks': GROUP_KEY, 'foc/kc': 'other', 'foc/enc': '1' } },
      { dataSetId: 5n, isLive: true, metadata: { 'foc/ks': OLDER, 'foc/kc': commitment, 'foc/enc': '1' } },
    ])
    const picked = await migrateGroupKey(asOwner, NO_SESSION)
    expect(picked.dataSetMetadata['foc/ks']).toBe(OLDER)
    expect(picked.dataSetMetadata).toEqual((await ownerGroupKey(asOwner, OWNER)).dataSetMetadata)
  })

  it("falls back to the owner's default group key, like add --encrypt", async () => {
    mockListDataSets.mockResolvedValue([])
    const picked = await migrateGroupKey(asOwner, NO_SESSION)
    expect(picked.dataSetMetadata['foc/ks']).toBe(GROUP_KEY)
  })

  it('needs the owner wallet or a session key Grant, never falling back to plaintext', async () => {
    const readOnly = { client: { account: OWNER.address }, chain: { id: 314159 } } as unknown as Synapse
    await expect(migrateGroupKey(readOnly, NO_SESSION)).rejects.toThrow(OWNER_WALLET_REQUIRED)
  })
})
