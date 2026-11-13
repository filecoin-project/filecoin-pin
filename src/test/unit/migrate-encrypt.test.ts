import { keyspaceKeys as deriveGroupKey } from '@filoz/keysmith'
import type { Synapse } from '@filoz/synapse-sdk'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OWNER_WALLET_REQUIRED, ownerGroupKey } from '../../common/group-key.js'
import type { DataSetSummary } from '../../core/data-set/index.js'
import type { SynapseSetupConfig } from '../../core/synapse/index.js'
import { assertEncryptedDataSets, migrateGroupKey, sourceGroupKeyId } from '../../migrate/migrate.js'
import { GROUP_KEY, makeGrant, OWNER, SESSION_KEY } from '../fixtures/group-key-grants.js'

const { mockListDataSets } = vi.hoisted(() => ({ mockListDataSets: vi.fn() }))
vi.mock('../../core/data-set/list-data-sets.js', () => ({ listDataSets: mockListDataSets }))

const OLDER = '0x00112233445566778899aabbccddeeff'
/** listDataSets over these data sets, applying the caller's filter as the real one does. */
const onChain = (dataSets: Array<Partial<DataSetSummary>>): void => {
  mockListDataSets.mockImplementation(async (_synapse, opts?: { filter?: (d: Partial<DataSetSummary>) => boolean }) =>
    dataSets.filter(opts?.filter ?? (() => true))
  )
}
const NO_SESSION = {} as SynapseSetupConfig
const asOwner = { client: { account: OWNER }, chain: { id: 314159 } } as unknown as Synapse

describe('sourceGroupKeyId', () => {
  // `printf %s gs://bk/scans | shasum -a 256 | cut -c1-32`
  it('is the first 16 bytes of sha256 of the source URL as typed', () => {
    expect(sourceGroupKeyId('gs://bk/scans')).toBe('0x607caab7156112fc8387bddea0735e0e')
  })

  it('reads gs://bucket/ as gs://bucket', () => {
    expect(sourceGroupKeyId('gs://bk/')).toBe('0x0ca5f5fbaaf9cb6cfdba092c0729ecac')
  })
})

describe('migrateGroupKey', () => {
  const SOURCE = 'gs://bk/scans'
  const SOURCE_KEY = '0x607caab7156112fc8387bddea0735e0e'

  it("writes under the source's group key, not the oldest one add --encrypt picks", async () => {
    const { commitment } = await deriveGroupKey(OWNER, { owner: OWNER.address, keyspace: OLDER })
    onChain([{ dataSetId: 5n, isLive: true, metadata: { 'foc/ks': OLDER, 'foc/kc': commitment, 'foc/enc': '1' } }])
    const picked = await migrateGroupKey(asOwner, NO_SESSION, SOURCE)
    expect(picked.dataSetMetadata['foc/ks']).toBe(SOURCE_KEY)
  })

  it('re-running a source reuses the data sets already tagged with its group key', async () => {
    mockListDataSets.mockResolvedValue([])
    const first = await migrateGroupKey(asOwner, NO_SESSION, SOURCE)
    onChain([{ dataSetId: 7n, isLive: true, metadata: first.dataSetMetadata }])
    const again = await migrateGroupKey(asOwner, NO_SESSION, SOURCE)
    expect(again.dataSetMetadata).toEqual(first.dataSetMetadata)
  })

  it('gives another source another group key, so it lands in other data sets', async () => {
    mockListDataSets.mockResolvedValue([])
    const scans = await migrateGroupKey(asOwner, NO_SESSION, SOURCE)
    const other = await migrateGroupKey(asOwner, NO_SESSION, 'gs://bk/invoices')
    expect(other.dataSetMetadata['foc/ks']).not.toBe(scans.dataSetMetadata['foc/ks'])
    expect(other.dataSetMetadata['foc/kc']).not.toBe(scans.dataSetMetadata['foc/kc'])
  })

  it("stops when the source's group key is on chain with another commitment", async () => {
    onChain([
      { dataSetId: 3n, isLive: true, metadata: { 'foc/ks': SOURCE_KEY, 'foc/kc': 'one', 'foc/enc': '1' } },
      { dataSetId: 4n, isLive: true, metadata: { 'foc/ks': SOURCE_KEY, 'foc/kc': 'two', 'foc/enc': '1' } },
    ])
    await expect(migrateGroupKey(asOwner, NO_SESSION, SOURCE)).rejects.toThrow(
      new RegExp(`group key ${SOURCE_KEY} .*data sets 3, 4`)
    )
  })

  it('needs the owner wallet or a session key Grant, never falling back to plaintext', async () => {
    const readOnly = { client: { account: OWNER.address }, chain: { id: 314159 } } as unknown as Synapse
    await expect(migrateGroupKey(readOnly, NO_SESSION, SOURCE)).rejects.toThrow(OWNER_WALLET_REQUIRED)
  })

  describe('with a session key', () => {
    const asSession = { client: { account: OWNER.address }, chain: { id: 314159 } } as unknown as Synapse
    const session = { sessionKey: SESSION_KEY, walletAddress: OWNER.address } as unknown as SynapseSetupConfig
    afterEach(() => vi.unstubAllEnvs())

    it("refuses a Grant for another group key, naming both, without using the Grant's key", async () => {
      vi.stubEnv('GROUP_KEY_GRANT', await makeGrant())
      vi.stubEnv('GROUP_KEY_ID', GROUP_KEY)
      mockListDataSets.mockClear()
      await expect(migrateGroupKey(asSession, session, SOURCE)).rejects.toThrow(
        `This session key's Grant is for group key ${GROUP_KEY}, but ${SOURCE} encrypts under group key ${SOURCE_KEY}; run with the owner wallet (set PRIVATE_KEY), or with a Grant for group key ${SOURCE_KEY}.`
      )
      expect(mockListDataSets).not.toHaveBeenCalled()
    })

    it("writes under a Grant for the source's group key", async () => {
      vi.stubEnv('GROUP_KEY_GRANT', await makeGrant({ groupKey: SOURCE_KEY }))
      vi.stubEnv('GROUP_KEY_ID', SOURCE_KEY)
      mockListDataSets.mockResolvedValue([])
      const picked = await migrateGroupKey(asSession, session, SOURCE)
      expect(picked.dataSetMetadata['foc/ks']).toBe(SOURCE_KEY)
    })
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
