import { keyspaceKeys as deriveGroupKey } from '@filoz/keysmith'
import type { Synapse } from '@filoz/synapse-sdk'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { OWNER_WALLET_REQUIRED, ownerGroupKey } from '../../common/group-key.js'
import type { SynapseSetupConfig } from '../../core/synapse/index.js'
import { assertEncryptedDataSets, migrateGroupKey } from '../../migrate/migrate.js'
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

describe('assertEncryptedDataSets', () => {
  it('takes an explicit data set only in this group key, as add --encrypt does', async () => {
    const groupKey = await ownerGroupKey(asOwner, OWNER)
    const logger = pino({ level: 'silent' })
    const encrypted = { ...groupKey.dataSetMetadata, withIPFSIndexing: '' }
    mockListDataSets.mockResolvedValue([
      { dataSetId: 1n, isLive: true, metadata: { withIPFSIndexing: '' } },
      { dataSetId: 2n, isLive: true, metadata: { ...encrypted, 'foc/ks': `0x${'ff'.repeat(16)}` } },
      { dataSetId: 3n, isLive: true, metadata: encrypted },
    ])
    await expect(assertEncryptedDataSets(asOwner, [1n], groupKey, logger)).rejects.toThrow(
      /Data set 1 .*foc\/enc is missing/
    )
    await expect(assertEncryptedDataSets(asOwner, [2n], groupKey, logger)).rejects.toThrow(/Data set 2 .*foc\/ks/)
    await expect(assertEncryptedDataSets(asOwner, [3n], groupKey, logger)).resolves.toBeUndefined()
  })
})
