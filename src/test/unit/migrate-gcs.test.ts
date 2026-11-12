import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCarFromPath } from '../../core/unixfs/car-builder.js'
import { MigrationDB } from '../../migrate/db.js'
import { type GcsFetch, listGcsObjects, parseGcsUrl, stageGcsObject } from '../../migrate/gcs.js'

const MEMBER = {
  pieceCid: 'bafkzcibpiece',
  rawSize: 100,
  gateway: 'gcs',
  url: 'gs://b/a.pdf',
  memberCarPath: '/tmp/a.car',
  memberSha256: 'aa'.repeat(32),
}

/** A fake JSON API: listing pages of `pageSize`, media reads by object name. */
function fakeBucket(objects: Record<string, Uint8Array<ArrayBuffer>>, pageSize = 2): GcsFetch {
  const names = Object.keys(objects).sort()
  return async (url) => {
    const u = new URL(url)
    const media = u.pathname.match(/^\/storage\/v1\/b\/([^/]+)\/o\/(.+)$/)
    if (media != null) {
      const bytes = objects[decodeURIComponent(media[2] ?? '')]
      return bytes == null ? new Response('missing', { status: 404 }) : new Response(bytes)
    }
    const prefix = u.searchParams.get('prefix') ?? ''
    const matching = names.filter((n) => n.startsWith(prefix))
    const start = Number(u.searchParams.get('pageToken') ?? 0)
    const page = matching.slice(start, start + pageSize)
    const next = start + pageSize < matching.length ? String(start + pageSize) : undefined
    return Response.json({
      items: page.map((name) => ({ name, size: String(objects[name]?.length), crc32c: `crc-${name}` })),
      ...(next != null && { nextPageToken: next }),
    })
  }
}

describe('parseGcsUrl', () => {
  it('splits a gs:// URL into bucket and prefix', () => {
    expect(parseGcsUrl('gs://county-a')).toEqual({ bucket: 'county-a', prefix: '' })
    expect(parseGcsUrl('gs://county-a/scans/2024/')).toEqual({ bucket: 'county-a', prefix: 'scans/2024/' })
  })

  it('returns null for anything else, so the argument reads as a CID list file', () => {
    expect(parseGcsUrl('cids.txt')).toBeNull()
    expect(parseGcsUrl('s3://bucket')).toBeNull()
  })
})

describe('listGcsObjects', () => {
  it('follows page tokens and keeps the prefix', async () => {
    const enc = new TextEncoder()
    const bucket = fakeBucket({
      'a/1': enc.encode('1'),
      'a/2': enc.encode('22'),
      'a/3': enc.encode('333'),
      b: enc.encode('x'),
    })
    const objects = await listGcsObjects({ bucket: 'bk', prefix: 'a/' }, bucket)
    expect(objects).toEqual([
      { url: 'gs://bk/a/1', size: 1, crc32c: 'crc-a/1' },
      { url: 'gs://bk/a/2', size: 2, crc32c: 'crc-a/2' },
      { url: 'gs://bk/a/3', size: 3, crc32c: 'crc-a/3' },
    ])
  })

  it('names the bucket when the listing is refused', async () => {
    const refused: GcsFetch = async () => new Response('denied', { status: 403 })
    await expect(listGcsObjects({ bucket: 'bk', prefix: '' }, refused)).rejects.toThrow(/gs:\/\/bk.*403/)
  })
})

describe('stageGcsObject', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fp-gcs-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('imports an object to the same root CID `add` gives the same bytes', async () => {
    const bytes = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251)
    const local = join(dir, 'scan.tiff')
    await writeFile(local, bytes)
    const added = await createCarFromPath(local, { tempDir: dir })
    const bucket = fakeBucket({ 'scans/scan.tiff': bytes })

    let counted = 0
    const member = await stageGcsObject('gs://bk/scans/scan.tiff', dir, { onBytes: (d) => (counted += d) }, bucket)

    expect(member.cid).toBe(added.rootCid.toString())
    expect(member.url).toBe('gs://bk/scans/scan.tiff')
    expect(member.rawSize).toBe((await readFile(member.memberCarPath)).length)
    expect(counted).toBe(member.rawSize)
  })

  it('fails as source_not_found when the object is gone', async () => {
    const bucket = fakeBucket({})
    await expect(stageGcsObject('gs://bk/gone', dir, {}, bucket)).rejects.toMatchObject({
      category: 'source_not_found',
    })
  })
})

describe('MigrationDB object sources', () => {
  const obj = (name: string, crc32c = `crc-${name}`) => ({ url: `gs://b/${name}`, size: 10, crc32c })

  it('queues new objects and skips ones already recorded with the same content', () => {
    const db = new MigrationDB(':memory:', 'test:0xabc')
    db.addSources([obj('a.pdf'), obj('b.pdf')])
    expect(db.pendingSources()).toEqual(['gs://b/a.pdf', 'gs://b/b.pdf'])

    expect(db.recordSourceSuccess('gs://b/a.pdf', { ...MEMBER, cid: 'bafkreia' })).toBe(true)
    db.addSources([obj('a.pdf'), obj('b.pdf')])
    expect(db.pendingSources()).toEqual(['gs://b/b.pdf'])
    expect(db.sources()).toContainEqual({ url: 'gs://b/a.pdf', cid: 'bafkreia', size: 10, crc32c: 'crc-a.pdf' })
    db.close()
  })

  it('re-queues an object whose content changed', () => {
    const db = new MigrationDB(':memory:', 'test:0xabc')
    db.addSources([obj('a.pdf')])
    db.recordSourceSuccess('gs://b/a.pdf', { ...MEMBER, cid: 'bafkreia' })
    db.addSources([obj('a.pdf', 'crc-new')])
    expect(db.pendingSources()).toEqual(['gs://b/a.pdf'])
    db.close()
  })

  it('maps a second object with the same content to the existing CID without restaging it', () => {
    const db = new MigrationDB(':memory:', 'test:0xabc')
    db.addSources([obj('a.pdf'), obj('copy.pdf')])
    expect(db.recordSourceSuccess('gs://b/a.pdf', { ...MEMBER, cid: 'bafkreia' })).toBe(true)
    expect(db.recordSourceSuccess('gs://b/copy.pdf', { ...MEMBER, cid: 'bafkreia', url: 'gs://b/copy.pdf' })).toBe(
      false
    )
    expect(db.pendingSources()).toEqual([])
    expect(db.counts()).toMatchObject({ total: 1, done: 1 })
    db.close()
  })

  it('re-queues an object whose piece the startup sweep reset', () => {
    const db = new MigrationDB(':memory:', 'test:0xabc')
    db.addSources([obj('a.pdf')])
    db.recordSourceSuccess('gs://b/a.pdf', { ...MEMBER, cid: 'bafkreia' })
    db.resetPieceToPending('bafkreia')
    expect(db.pendingSources()).toEqual(['gs://b/a.pdf'])
    db.close()
  })

  it('counts a failed object as failed in the summary so the run exits non-zero', () => {
    const db = new MigrationDB(':memory:', 'test:0xabc')
    db.addSources([obj('a.pdf'), obj('b.pdf')])
    db.recordSourceFailure('gs://b/a.pdf', 'HTTP 403', 'other')
    expect(db.counts()).toMatchObject({ total: 2, failed: 1, pending: 1 })
    expect(db.failures()).toEqual([{ cid: 'gs://b/a.pdf', error: 'HTTP 403', category: 'other' }])
    expect(db.pendingSources()).toEqual(['gs://b/a.pdf', 'gs://b/b.pdf'])
    db.close()
  })
})
