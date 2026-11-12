import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { keyspaceKeys as deriveGroupKey, type WriteTarget, writeTarget } from '@filoz/keysmith'
import type { Synapse } from '@filoz/synapse-sdk'
import { CarBlockIterator, CarWriter } from '@ipld/car'
import toBuffer from 'it-to-buffer'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptToDirectory } from '../../common/encryption.js'
import { ownerGroupKey, ownerKeyResolver } from '../../common/group-key.js'
import type { DataSetSummary } from '../../core/data-set/index.js'
import { MigrationDB } from '../../migrate/db.js'
import { encryptMember } from '../../migrate/encrypt-member.js'
import { runPackCars } from '../../migrate/pack-cars.js'
import { GROUP_KEY, OWNER } from '../fixtures/group-key-grants.js'

const { mockListDataSets } = vi.hoisted(() => ({ mockListDataSets: vi.fn() }))
vi.mock('../../core/data-set/list-data-sets.js', () => ({ listDataSets: mockListDataSets }))

const TENANT_KEY = '0x00112233445566778899aabbccddeeff'

async function memberCar(text: string): Promise<{ cid: string; bytes: Uint8Array }> {
  const data = new TextEncoder().encode(text)
  const cid = CID.createV1(raw.code, await sha256.digest(data))
  const { writer, out } = CarWriter.create([cid])
  const done = toBuffer(out)
  await writer.put({ cid, bytes: data })
  await writer.close()
  return { cid: cid.toString(), bytes: await done }
}

describe('encryptMember', () => {
  let dir: string
  let memberDir: string
  let target: WriteTarget

  beforeAll(async () => {
    const { kk, descriptor } = await deriveGroupKey(OWNER, { owner: OWNER.address, keyspace: TENANT_KEY })
    target = writeTarget(descriptor, kk)
  })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fp-migrate-encrypt-'))
    memberDir = join(dir, 'members')
    await mkdir(memberDir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function stage(text: string) {
    const { cid, bytes } = await memberCar(text)
    const memberCarPath = join(memberDir, `${cid}.car`)
    await writeFile(memberCarPath, bytes)
    const member = {
      cid,
      pieceCid: 'unused',
      rawSize: bytes.length,
      gateway: 'gw',
      url: 'u',
      memberCarPath,
      memberSha256: 'unused',
    }
    return { member, bytes }
  }

  it('replaces the plaintext member with an envelope CAR that restores to <source-cid>.car', async () => {
    const { member, bytes } = await stage('county record')

    const encrypted = await encryptMember(member, target)

    expect(encrypted.storedCid).not.toBe(member.cid)
    expect(encrypted.memberCarPath).toBe(join(memberDir, `${encrypted.storedCid}.car`))
    expect(await readdir(memberDir)).toEqual([`${encrypted.storedCid}.car`])
    const stored = await readFile(encrypted.memberCarPath)
    expect(encrypted.rawSize).toBe(stored.length)
    expect(Buffer.from(stored).includes(Buffer.from('county record'))).toBe(false)

    const out = join(dir, 'out')
    const restored = await decryptToDirectory(encrypted.memberCarPath, out, ownerKeyResolver(OWNER))
    expect(restored.path).toBe(join(out, `${member.cid}.car`))
    expect((await readFile(restored.path)).equals(bytes)).toBe(true)
  })

  it('packs the stored CID as the piece root and records source -> stored in the DB', async () => {
    const { member } = await stage('another county record')
    const encrypted = await encryptMember(member, target)
    const dbPath = join(dir, 'migrate.db')
    const db = new MigrationDB(dbPath, 'calibration:0xabc')
    try {
      db.addCids([member.cid])
      db.recordPieceSuccess(member.cid, encrypted)
      const carStore = join(dir, 'cars')

      const summary = await runPackCars(db, { carStore, targetSizeBytes: 1024 * 1024, final: true })

      expect(summary.built).toBe(1)
      const [built] = db.subPiecesByStatus('built')
      const reader = await CarBlockIterator.fromBytes(await readFile(String(built?.carPath)))
      expect((await reader.getRoots()).map(String)).toEqual([encrypted.storedCid])
    } finally {
      db.close()
    }
    const sqlite = new DatabaseSync(dbPath)
    try {
      expect(sqlite.prepare('SELECT cid, stored_cid FROM pieces').all()).toEqual([
        { cid: member.cid, stored_cid: encrypted.storedCid },
      ])
    } finally {
      sqlite.close()
    }
  })
})

describe('ownerGroupKey with an explicit group key', () => {
  const dataSet = (id: bigint, metadata: Record<string, string>): DataSetSummary =>
    ({ dataSetId: id, isLive: true, metadata }) as unknown as DataSetSummary
  const synapse = {} as Synapse

  function onChain(dataSets: DataSetSummary[]): void {
    mockListDataSets.mockImplementation(async (_synapse, options: { filter: (d: DataSetSummary) => boolean }) =>
      dataSets.filter(options.filter)
    )
  }

  it('writes under the named group key even when an older one exists', async () => {
    const { commitment } = await deriveGroupKey(OWNER, { owner: OWNER.address, keyspace: GROUP_KEY })
    onChain([dataSet(1n, { 'foc/enc': '1', 'foc/ks': GROUP_KEY, 'foc/kc': commitment })])

    const { dataSetMetadata } = await ownerGroupKey(synapse, OWNER, undefined, TENANT_KEY)

    expect(dataSetMetadata['foc/ks']).toBe(TENANT_KEY)
  })

  it('refuses a named group key whose data sets are not valid', async () => {
    onChain([
      dataSet(5n, { 'foc/enc': '1', 'foc/ks': TENANT_KEY, 'foc/kc': 'a' }),
      dataSet(6n, { 'foc/ks': TENANT_KEY }),
    ])

    await expect(ownerGroupKey(synapse, OWNER, undefined, TENANT_KEY)).rejects.toThrow(/5, 6/)
  })
})
