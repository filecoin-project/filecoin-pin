import { describe, expect, it } from 'vitest'
import { MigrationDB } from '../../migrate/db.js'
import { parseSize } from '../../utils/cli-helpers.js'

const CID_A = 'bafkreialpha'
const CID_B = 'bafkreibravo'
const SUB_1 = 'bafkreisubone'
const SUB_2 = 'bafkreisubtwo'
const PRIMARY = 'provider-1'
const SECONDARY = 'provider-2'

function openDb(): MigrationDB {
  return new MigrationDB(':memory:', 'test:0xabc')
}

/** One downloaded member packed into one built sub-piece. */
function stageOne(db: MigrationDB, cid: string, subPieceCid: string): void {
  db.addCids([cid])
  db.recordPieceSuccess(cid, {
    pieceCid: 'bafkzcibtest',
    rawSize: 100,
    gateway: 'https://gw.example',
    url: `https://gw.example/ipfs/${cid}`,
    memberCarPath: `/tmp/${cid}.car`,
    memberSha256: 'aa'.repeat(32),
  })
  db.recordBuiltSubPiece({
    subPieceCid,
    assembledCarLength: 120,
    targetSizeBytes: 1000,
    carPath: `/tmp/${subPieceCid}.car`,
    assembledSha256: 'bb'.repeat(32),
    members: [{ cid, rawSize: 100, sha256: 'aa'.repeat(32) }],
  })
}

describe('MigrationDB resume transitions', () => {
  it('re-schedules a secondary copy after the provider collected it', () => {
    const db = openDb()
    stageOne(db, CID_A, SUB_1)
    db.recordUploadParked(SUB_1, PRIMARY, 'primary', '1')
    db.markUploadCommitted(SUB_1, PRIMARY, { dataSetId: '1', pieceId: '1', txHash: '0x01' })

    db.recordUploadParked(SUB_1, SECONDARY, 'secondary', null)
    db.markUploadCollected(SUB_1, SECONDARY)

    expect(db.subPiecesMissingSecondary(PRIMARY, SECONDARY)).toEqual([SUB_1])
  })

  it('refuses a rebuild while a secondary copy is committed', () => {
    const db = openDb()
    stageOne(db, CID_A, SUB_1)
    db.recordUploadParked(SUB_1, PRIMARY, 'primary', '1')
    db.markUploadCollected(SUB_1, PRIMARY)
    db.recordUploadParked(SUB_1, SECONDARY, 'secondary', '1')
    db.markUploadCommitted(SUB_1, SECONDARY, { dataSetId: '1', pieceId: '2', txHash: '0x02' })

    expect(() => db.deleteSubPieceForRebuild(SUB_1)).toThrow(/committed/)
    expect(db.uploadsByStatus(SECONDARY, 'committed')).toHaveLength(1)
  })

  it('resets members to pending in the same transaction as a rebuild', () => {
    const db = openDb()
    stageOne(db, CID_A, SUB_1)

    const members = db.deleteSubPieceForRebuild(SUB_1)

    expect(members).toEqual([CID_A])
    expect(db.pendingCids()).toEqual([CID_A])
    expect(db.subPiecesByStatus('built')).toHaveLength(0)
  })

  it('does not demote a committed upload back to parked', () => {
    const db = openDb()
    stageOne(db, CID_A, SUB_1)
    db.recordUploadParked(SUB_1, PRIMARY, 'primary', '1')
    db.markUploadCommitted(SUB_1, PRIMARY, { dataSetId: '1', pieceId: '1', txHash: '0x01' })

    db.recordUploadParked(SUB_1, PRIMARY, 'primary', '1')

    const committed = db.uploadsByStatus(PRIMARY, 'committed')
    expect(committed).toHaveLength(1)
    expect(committed[0]?.txHash).toBe('0x01')
    expect(db.uploadsByStatus(PRIMARY, 'parked')).toHaveLength(0)
  })

  it('rejects packing the same member into a second sub-piece', () => {
    const db = openDb()
    stageOne(db, CID_A, SUB_1)
    db.addCids([CID_B])
    db.recordPieceSuccess(CID_B, {
      pieceCid: 'bafkzcibother',
      rawSize: 50,
      gateway: 'https://gw.example',
      url: `https://gw.example/ipfs/${CID_B}`,
      memberCarPath: `/tmp/${CID_B}.car`,
      memberSha256: 'cc'.repeat(32),
    })

    expect(() =>
      db.recordBuiltSubPiece({
        subPieceCid: SUB_2,
        assembledCarLength: 200,
        targetSizeBytes: 1000,
        carPath: `/tmp/${SUB_2}.car`,
        assembledSha256: 'dd'.repeat(32),
        members: [
          { cid: CID_B, rawSize: 50, sha256: 'cc'.repeat(32) },
          { cid: CID_A, rawSize: 100, sha256: 'aa'.repeat(32) },
        ],
      })
    ).toThrow()
    // The failed transaction must not half-commit: CID_B stays packable.
    expect(db.subPiecesByStatus('built')).toHaveLength(1)
    expect(db.donePiecesFreeForPacking().map((p) => p.cid)).toEqual([CID_B])
  })
})

describe('parseSize decimal aliases', () => {
  it('treats kb/mb/gb/tb as their binary equivalents', () => {
    expect(parseSize('32GB')).toBe(32n * 1024n ** 3n)
    expect(parseSize('32GiB')).toBe(32n * 1024n ** 3n)
    expect(parseSize('1mb')).toBe(1024n ** 2n)
    expect(parseSize('2tb')).toBe(2n * 1024n ** 4n)
  })
})
