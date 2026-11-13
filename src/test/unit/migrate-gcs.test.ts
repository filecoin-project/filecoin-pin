import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keyspaceKeys as deriveGroupKey, type WriteTarget, writeTarget } from '@filoz/keysmith'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { decryptToDirectory } from '../../common/encryption.js'
import { ownerKeyResolver } from '../../common/group-key.js'
import { createCarFromPath } from '../../core/unixfs/car-builder.js'
import { MigrationDB } from '../../migrate/db.js'
import { type GcsFetch, listGcsObjects, parseGcsUrl, stageGcsObject } from '../../migrate/gcs.js'
import { GROUP_KEY, OWNER } from '../fixtures/group-key-grants.js'

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

  /** A bucket whose one object streams `chunks`, then errors when `fail` is set. */
  function streamingBucket(chunks: Uint8Array[], onPull: () => void, fail = false): GcsFetch {
    return async () => {
      let i = 0
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            onPull()
            const chunk = chunks[i++]
            if (chunk != null) controller.enqueue(chunk)
            else if (fail) controller.error(new Error('connection reset'))
            else controller.close()
          },
        })
      )
    }
  }

  it('counts bytes while the import is still reading the object', async () => {
    let counted = 0
    const countedAtPull: number[] = []
    const chunks = [new Uint8Array(1000).fill(1), new Uint8Array(1000).fill(2)]
    const bucket = streamingBucket(chunks, () => countedAtPull.push(counted))
    await stageGcsObject('gs://bk/a', dir, { onBytes: (d) => (counted += d) }, bucket)
    expect(countedAtPull.at(-1)).toBeGreaterThan(0)
  })

  it('frees its bytes and its temp CAR when the import fails', async () => {
    let counted = 0
    const bucket = streamingBucket([new Uint8Array(3 * 1024 * 1024).fill(7)], () => undefined, true)
    await expect(stageGcsObject('gs://bk/a', dir, { onBytes: (d) => (counted += d) }, bucket)).rejects.toThrow(
      /connection reset/
    )
    expect(counted).toBe(0)
    expect(await readdir(dir)).toEqual([])
  })

  it('stops the import as soon as the budget refuses more bytes', async () => {
    let counted = 0
    let pulls = 0
    const chunks = Array.from({ length: 10 }, () => new Uint8Array(1000))
    const bucket = streamingBucket(chunks, () => pulls++)
    const onBytes = (d: number): void => {
      counted += d
      if (d > 0 && counted > 2500) throw new Error('budget exhausted')
    }
    await expect(stageGcsObject('gs://bk/a', dir, { onBytes }, bucket)).rejects.toThrow(/budget exhausted/)
    expect(pulls).toBeLessThan(10)
    expect(counted).toBe(0)
    expect(await readdir(dir)).toEqual([])
  })

  it('fails as source_not_found when the object is gone', async () => {
    const bucket = fakeBucket({})
    await expect(stageGcsObject('gs://bk/gone', dir, {}, bucket)).rejects.toMatchObject({
      category: 'source_not_found',
    })
  })
})

describe('stageGcsObject with --encrypt', () => {
  let dir: string
  let target: WriteTarget
  beforeAll(async () => {
    const { kk, descriptor } = await deriveGroupKey(OWNER, { owner: OWNER.address, keyspace: GROUP_KEY })
    target = writeTarget(descriptor, kk)
  })
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fp-gcs-enc-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('restores the exact object bytes the way add --encrypt content is restored', async () => {
    const bytes = randomBytes(3 * 1024 * 1024 + 17)
    const bucket = fakeBucket({ 'scans/2024/scan.tiff': bytes })
    let counted = 0
    const member = await stageGcsObject(
      'gs://bk/scans/2024/scan.tiff',
      dir,
      { onBytes: (d) => (counted += d) },
      bucket,
      target
    )
    expect(counted).toBe(member.rawSize)

    const out = join(dir, 'out')
    await decryptToDirectory(member.memberCarPath, out, ownerKeyResolver(OWNER))
    expect((await readFile(join(out, 'scan.tiff'))).equals(bytes)).toBe(true)
  })

  it('never writes plaintext to the staging directory', async () => {
    const marker = randomBytes(64)
    const bytes = Buffer.concat(Array.from({ length: 40_000 }, () => marker))
    const leaked: string[] = []
    const scan = async (): Promise<void> => {
      for (const f of await readdir(dir)) {
        const data = await readFile(join(dir, f)).catch(() => Buffer.alloc(0))
        if (data.includes(marker)) leaked.push(f)
      }
    }
    const bucket: GcsFetch = async () => {
      let sent = 0
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await scan()
            if (sent >= bytes.length) return controller.close()
            controller.enqueue(bytes.subarray(sent, sent + 256 * 1024))
            sent += 256 * 1024
          },
        })
      )
    }
    const member = await stageGcsObject('gs://bk/a.bin', dir, {}, bucket, target)
    await scan()
    expect(leaked).toEqual([])
    expect(await readdir(dir)).toEqual([member.memberCarPath.split('/').at(-1)])
  })

  it('downloads the object from GCS once', async () => {
    const bytes = randomBytes(3 * 1024 * 1024 + 5)
    const bucket = fakeBucket({ 'a.bin': bytes })
    let fetches = 0
    const counting: GcsFetch = async (url) => {
      fetches++
      return bucket(url)
    }
    await stageGcsObject('gs://bk/a.bin', dir, {}, counting, target)
    expect(fetches).toBe(1)
  })

  /** One object of `size` bytes; `beforeClose` runs once every byte has been read. */
  function oneObject(size: number, beforeClose: () => Promise<void>, fail = false): GcsFetch {
    return async () => {
      let sent = false
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (!sent) {
              sent = true
              return controller.enqueue(randomBytes(size))
            }
            await beforeClose()
            if (fail) return controller.error(new Error('connection reset'))
            controller.close()
          },
        })
      )
    }
  }

  it('fails clearly when its temporary copy changes before encryption, and removes it', async () => {
    let counted = 0
    const bucket = oneObject(2 * 1024 * 1024, async () => {
      const [spool] = await readdir(dir)
      await writeFile(join(dir, String(spool)), randomBytes(1024 * 1024), { flag: 'r+' })
    })
    await expect(
      stageGcsObject('gs://bk/a.bin', dir, { onBytes: (d) => (counted += d) }, bucket, target)
    ).rejects.toThrow(/gs:\/\/bk\/a\.bin: its temporary copy changed on disk; re-run/)
    expect(counted).toBe(0)
    expect(await readdir(dir)).toEqual([])
  })

  it('counts its temporary copy against the budget and removes it when the download fails', async () => {
    let peak = 0
    let counted = 0
    const bucket = oneObject(1024 * 1024, async () => undefined, true)
    const onBytes = (d: number): void => {
      counted += d
      peak = Math.max(peak, counted)
    }
    await expect(stageGcsObject('gs://bk/a.bin', dir, { onBytes }, bucket, target)).rejects.toThrow(/connection reset/)
    expect(peak).toBe(1024 * 1024)
    expect(counted).toBe(0)
    expect(await readdir(dir)).toEqual([])
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

  it('refuses to switch an object between plain and encrypted, registering nothing', () => {
    const db = new MigrationDB(':memory:', 'test:0xabc')
    db.addSources([obj('a.pdf')])
    expect(() => db.addSources([obj('new.pdf'), obj('a.pdf')], true)).toThrow(
      /gs:\/\/b\/a\.pdf was migrated without --encrypt.*different --db/
    )
    expect(db.sources().map((s) => s.url)).toEqual(['gs://b/a.pdf'])
    db.addSources([{ url: 'gs://other/x.pdf', size: 10, crc32c: 'x' }], true)
    expect(() => db.addSources([{ url: 'gs://other/x.pdf', size: 10, crc32c: 'x' }])).toThrow(
      /gs:\/\/other\/x\.pdf was migrated with --encrypt/
    )
    db.close()
  })
})
