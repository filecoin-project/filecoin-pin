import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MigrationDB } from '../../migrate/db.js'
import { type BinBuilder, MAX_UPLOAD_BYTES, runPackCars } from '../../migrate/pack-cars.js'

const undeletable = vi.hoisted(() => ({ on: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    unlink: (filePath: string) =>
      undeletable.on ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })) : fs.unlink(filePath),
  }
})

const CID_A = 'bafkzcibf3ck4uais4fgennh4hbfx5z3i6hue4xgq2cdeamtus4hjbsrjs5lf2azbxmsa'

/** Pack one member whose bin fails; returns the net staged bytes and the files left behind. */
async function packFailingBin(buildBin?: BinBuilder): Promise<{ staged: number; left: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'fp-pack-fail-'))
  const db = new MigrationDB(':memory:', 'test:0xabc')
  try {
    db.addCids([CID_A])
    db.recordPieceSuccess(CID_A, {
      pieceCid: CID_A,
      rawSize: 1000,
      gateway: 'g',
      url: 'fake://gw/x',
      memberCarPath: join(dir, 'missing.car'),
      memberSha256: 'sha',
    })
    let staged = 0
    const summary = await runPackCars(db, { carStore: dir, onBytesStaged: (d) => (staged += d) }, buildBin)
    expect(summary.failed).toBe(1)
    return { staged, left: await readdir(dir) }
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
}

// Over the upload cap, so the pack loop rejects the finalized CAR.
const overCapBuilder: BinBuilder = async (_bin, carStore, _paths, onBytes) => {
  onBytes?.(10)
  return { pieceCid: 'p', assembledBytes: MAX_UPLOAD_BYTES + 1, sha256: 's', filePath: join(carStore, 'p.car') }
}

describe('runPackCars failed-bin refund', () => {
  afterEach(() => {
    undeletable.on = false
  })

  it('keeps counting a finalized CAR it could not delete', async () => {
    expect((await packFailingBin(overCapBuilder)).staged).toBe(0)
    undeletable.on = true
    expect((await packFailingBin(overCapBuilder)).staged).toBe(10)
  })

  it('keeps counting a temp file it could not delete', async () => {
    expect(await packFailingBin()).toEqual({ staged: 0, left: [] })
    undeletable.on = true
    const { staged, left } = await packFailingBin()
    expect(left).toHaveLength(1)
    expect(staged).toBeGreaterThan(0)
  })
})
