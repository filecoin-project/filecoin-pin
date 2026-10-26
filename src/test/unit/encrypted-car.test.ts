import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keyspaceKeys as deriveGroupKey, writeTarget } from '@filoz/keysmith'
import { CarBlockIterator, CarWriter } from '@ipld/car'
import * as dagPb from '@ipld/dag-pb'
import * as fee from 'filecoin-encryption-envelope'
import { UnixFS } from 'ipfs-unixfs'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { decryptToDirectory, encryptPath } from '../../common/encryption.js'
import { newPieceKey, ownerKeyResolver, type PieceKey } from '../../common/group-key.js'
import { CAR_CONTENT_TYPE, DAG_PB_CODEC, decodeVarint, RAW_CODEC } from '../../common/unixfs-car-layout.js'
import { EncryptInputError, emitCarPayload, planCarPayload } from '../../common/unixfs-car-payload.js'
import { insideDir } from '../../common/unixfs-car-unpack.js'
import { createCarFromPath } from '../../core/unixfs/car-builder.js'

// Anvil development keys #0 and #1, as in Keysmith's pinned vectors.
const OWNER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const STRANGER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const MiB = 1024 * 1024

async function collect(gen: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = []
  for await (const chunk of gen) parts.push(chunk)
  return Buffer.concat(parts)
}

describe('encrypted CAR payload', () => {
  let dir: string
  let input: string
  let envelope: string
  let outDir: string
  let pieceKey: () => PieceKey
  const asOwner = () => ownerKeyResolver(OWNER)

  beforeAll(async () => {
    const { kk, descriptor } = await deriveGroupKey(OWNER, {
      owner: OWNER.address,
      keyspace: '0x00112233445566778899aabbccddeeff',
    })
    const target = writeTarget(descriptor, kk)
    pieceKey = () => newPieceKey(target)
  })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'filecoin-pin-unixfs-car-'))
    input = join(dir, 'input')
    envelope = join(dir, 'encrypted.fee')
    outDir = join(dir, 'out')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips a single file under its own name', async () => {
    const content = randomBytes(2.5 * MiB)
    await writeFile(input, content)

    await encryptPath(input, envelope, pieceKey())
    const result = await decryptToDirectory(envelope, outDir, asOwner())

    expect(result).toMatchObject({ files: 1, dirs: 0, bytes: content.length })
    expect((await readFile(join(outDir, 'input'))).equals(content)).toBe(true)
    if (process.platform !== 'win32') {
      expect((await stat(outDir)).mode & 0o777).toBe(0o700)
      expect((await stat(join(outDir, 'input'))).mode & 0o777).toBe(0o600)
    }
  })

  it('round-trips a directory: nesting, empty file, empty dir, long Unicode name; symlinks skipped', async () => {
    const longName = `Résumé 履歴書 ${'x'.repeat(90)}.txt`
    await mkdir(join(input, 'docs', 'deeper'), { recursive: true })
    await mkdir(join(input, 'empty-dir'))
    const big = randomBytes(1.5 * MiB)
    await writeFile(join(input, 'big.bin'), big)
    await writeFile(join(input, 'docs', 'a.txt'), 'a')
    await writeFile(join(input, 'docs', 'deeper', longName), 'deep')
    await writeFile(join(input, 'docs', 'empty.txt'), '')
    await symlink('/etc/passwd', join(input, 'docs', 'evil'))

    const { plan } = await encryptPath(input, envelope, pieceKey())
    const result = await decryptToDirectory(envelope, outDir, asOwner())

    expect(plan.walk.skippedSymlinks).toEqual(['input/docs/evil'])
    expect(result.files).toBe(4)
    expect((await readFile(join(outDir, 'input', 'big.bin'))).equals(big)).toBe(true)
    expect(await readFile(join(outDir, 'input', 'docs', 'a.txt'), 'utf8')).toBe('a')
    expect(await readFile(join(outDir, 'input', 'docs', 'deeper', longName), 'utf8')).toBe('deep')
    expect(await readFile(join(outDir, 'input', 'docs', 'empty.txt'), 'utf8')).toBe('')
    expect((await stat(join(outDir, 'input', 'empty-dir'))).isDirectory()).toBe(true)
    expect(existsSync(join(outDir, 'input', 'docs', 'evil'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('reports and skips a FIFO instead of reading it', async () => {
    await mkdir(input)
    await writeFile(join(input, 'a.txt'), 'a')
    execFileSync('mkfifo', [join(input, 'pipe')])

    const { plan } = await encryptPath(input, envelope, pieceKey())
    await decryptToDirectory(envelope, outDir, asOwner())

    expect(plan.walk.skippedSpecial).toEqual(['input/pipe'])
    expect(plan.walk.files.map((f) => f.rel)).toEqual(['input/a.txt'])
    expect(existsSync(join(outDir, 'input', 'pipe'))).toBe(false)
  })

  it('skips hidden entries unless asked, like add', async () => {
    await mkdir(join(input, '.git'), { recursive: true })
    await writeFile(join(input, '.git', 'HEAD'), 'ref')
    await writeFile(join(input, '.env'), 'secret')
    await writeFile(join(input, 'visible.txt'), 'v')

    const skipped = await planCarPayload(input)
    expect([...skipped.layout.files.keys()]).toEqual(['input/visible.txt'])
    const kept = await planCarPayload(input, { includeHidden: true })
    expect([...kept.layout.files.keys()].sort()).toEqual(['input/.env', 'input/.git/HEAD', 'input/visible.txt'])
  })

  it('stores a repeated chunk once and restores every copy', async () => {
    const chunk = randomBytes(MiB)
    const content = Buffer.concat([chunk, randomBytes(MiB), chunk, chunk])
    await writeFile(input, content)

    const plan = await planCarPayload(input)
    expect(plan.layout.leaves).toHaveLength(2)
    expect(plan.layout.leaves[0]?.targets.map((t) => t.fileOffset)).toEqual([0, 2 * MiB, 3 * MiB])

    await encryptPath(input, envelope, pieceKey())
    await decryptToDirectory(envelope, outDir, asOwner())
    expect((await readFile(join(outDir, 'input'))).equals(content)).toBe(true)
  })

  it('emits every dag-pb node before the first raw leaf and matches the computed layout', async () => {
    await mkdir(input)
    await writeFile(join(input, 'one.bin'), randomBytes(1.2 * MiB))
    await writeFile(join(input, 'two.txt'), 'two')

    const plan = await planCarPayload(input)
    const car = await collect(emitCarPayload(plan))
    expect(car.length).toBe(plan.contentLength)

    const codecs: number[] = []
    for await (const block of await CarBlockIterator.fromBytes(car)) codecs.push(block.cid.code)
    const firstRaw = codecs.indexOf(RAW_CODEC)
    expect(codecs.slice(0, firstRaw).every((c) => c === DAG_PB_CODEC)).toBe(true)
    expect(codecs.slice(firstRaw).every((c) => c === RAW_CODEC)).toBe(true)
    for (const leaf of plan.layout.leaves) {
      const prefix = decodeVarint(car, leaf.offset)
      expect(prefix).toBeDefined()
      const [, prefixLength] = prefix ?? [0, 0]
      expect(CID.decodeFirst(car.subarray(leaf.offset + prefixLength))[0].equals(leaf.cid)).toBe(true)
      const digest = await sha256.digest(car.subarray(leaf.dataOffset, leaf.dataOffset + leaf.len))
      expect(CID.createV1(RAW_CODEC, digest).equals(leaf.cid)).toBe(true)
    }
  })

  it('fails if a file changes between the two passes, naming it only by position', async () => {
    await writeFile(input, randomBytes(MiB))
    const plan = await planCarPayload(input)
    await writeFile(input, randomBytes(MiB))

    const error = await collect(emitCarPayload(plan)).catch((e: Error) => e)
    expect(error).toBeInstanceOf(EncryptInputError)
    expect((error as Error).message).toBe('Input changed during encryption (entry #1); re-run')
  })

  it('fails on a same-size rewrite with its mtime restored, before emitting the changed leaf', async () => {
    await writeFile(input, randomBytes(3 * MiB))
    // Whole seconds, so restoring them is exact to the nanosecond and size + mtime see no change.
    const stamp = 1_700_000_000
    await utimes(input, stamp, stamp)
    const plan = await planCarPayload(input)
    const beforeLeaves = 1 + 3 * plan.layout.metadata.length
    let yielded = 0
    const consume = async () => {
      for await (const _ of emitCarPayload(plan)) {
        yielded++
        if (yielded === beforeLeaves) {
          await writeFile(input, randomBytes(3 * MiB))
          await utimes(input, stamp, stamp)
        }
      }
    }

    const error = await consume().catch((e: Error) => e)
    expect(error).toBeInstanceOf(EncryptInputError)
    expect((error as Error).message).toBe('Input changed during encryption (entry #1); re-run')
    expect(yielded).toBe(beforeLeaves)
  })

  it('stops at a short read in pass 2 instead of emitting the rest', async () => {
    await writeFile(input, randomBytes(3 * MiB))
    const plan = await planCarPayload(input)
    const beforeLeaves = 1 + 3 * plan.layout.metadata.length
    let yielded = 0
    const consume = async () => {
      for await (const _ of emitCarPayload(plan)) {
        yielded++
        // Header and every dag-pb section are out: shrink the file before the first leaf is read.
        if (yielded === beforeLeaves) await truncate(input, 0)
      }
    }

    await expect(consume()).rejects.toThrow('Input changed during encryption (entry #1); re-run')
    expect(yielded).toBe(beforeLeaves)
  })

  // Windows treats `\` as a separator, so the name can't be created there.
  it.skipIf(process.platform === 'win32')('names unreadable and unrestorable entries only by position', async () => {
    await mkdir(input)
    await writeFile(join(input, 'secret-a.txt'), 'a')
    await writeFile(join(input, 'secret\\b.txt'), 'b')

    const error = await encryptPath(input, envelope, pieceKey()).catch((e: Error) => e)
    expect((error as Error).message).toBe('Entry #3 has a name containing "\\", which cannot be restored safely')
    expect((error as Error).message).not.toContain('secret')
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports an unreadable file by position and error code only',
    async () => {
      await mkdir(input)
      await writeFile(join(input, 'secret.txt'), 'a')
      await chmod(join(input, 'secret.txt'), 0)

      const error = await encryptPath(input, envelope, pieceKey()).catch((e: Error) => e)
      expect((error as Error).message).toBe('Cannot read an input entry (entry #2): EACCES')
    }
  )

  it('reports any other failure by error code only', async () => {
    await writeFile(input, 'x')
    const missing = join(dir, 'missing-dir', 'encrypted.fee')

    await expect(encryptPath(input, missing, pieceKey())).rejects.toThrow(/^Encryption failed: ENOENT$/)
  })

  it('refuses an input whose files fit the cap but whose packed CAR does not', async () => {
    await writeFile(input, randomBytes(2048))
    // Exactly the file size: passes the files check (so it is `>`, not `>=`), fails the CAR check.
    const error = await encryptPath(input, envelope, pieceKey(), {}, 2048).catch((e: Error) => e)
    expect((error as Error).message).toMatch(/^The packed input is \d+ bytes, more than the 2048 bytes/)
  })

  it('accepts an input whose packed CAR is exactly the cap', async () => {
    await writeFile(input, randomBytes(2048))
    const { contentLength } = await planCarPayload(input)

    await expect(encryptPath(input, envelope, pieceKey(), {}, contentLength)).resolves.toBeDefined()
  })

  it('refuses an input larger than the upload cap before hashing it', async () => {
    await writeFile(input, randomBytes(2048))
    await expect(encryptPath(input, envelope, pieceKey(), {}, 1024)).rejects.toThrow(
      'The input is 2048 bytes, more than the 1024 bytes one upload can hold; split it into smaller uploads'
    )
    expect(existsSync(envelope)).toBe(false)
  })

  it('uses a fresh salt and nonce on every encryption of the same input', async () => {
    await writeFile(input, randomBytes(4096))
    const second = join(dir, 'second.fee')
    await encryptPath(input, envelope, pieceKey())
    await encryptPath(input, second, pieceKey())

    const [a, b] = [await readFile(envelope), await readFile(second)]
    const [infoA, infoB] = [await fee.parse(new Uint8Array(a)), await fee.parse(new Uint8Array(b))]
    expect(infoA.appMetadata?.['foc/salt']).not.toBe(infoB.appMetadata?.['foc/salt'])
    if (infoA.scheme !== 'chunked' || infoB.scheme !== 'chunked') throw new Error('expected the chunked scheme')
    expect(a.subarray(infoA.params.headerLength).equals(b.subarray(infoB.params.headerLength))).toBe(false)
  })

  it('records the inner CAR length as plaintextLength and writes the envelope owner-only', async () => {
    await writeFile(input, randomBytes(1.5 * MiB))
    const { plan } = await encryptPath(input, envelope, pieceKey())

    const info = await fee.parse(new Uint8Array(await readFile(envelope)))
    if (info.scheme !== 'chunked') throw new Error('expected the chunked scheme')
    expect(info.params.plaintextLength).toBe(plan.contentLength)
    expect(plan.contentLength).toBe((await collect(emitCarPayload(plan))).length)
    if (process.platform !== 'win32') {
      expect((await stat(envelope)).mode & 0o777).toBe(0o600)
    }
  })

  it('rejects a corrupted leaf inside a valid envelope and leaves nothing behind', async () => {
    await writeFile(input, randomBytes(2.5 * MiB))
    const plan = await planCarPayload(input)
    const car = new Uint8Array(await collect(emitCarPayload(plan)))
    const leaf = plan.layout.leaves[1]
    if (leaf == null) throw new Error('no second leaf')
    car[leaf.dataOffset] = (car[leaf.dataOffset] ?? 0) ^ 0xff
    const { cek, appMetadata } = pieceKey()
    const sealed = new Blob([car])
      .stream()
      .pipeThrough(fee.encrypt({ cek, appMetadata, contentType: CAR_CONTENT_TYPE }))
    await writeFile(envelope, Buffer.from(await new Response(sealed).arrayBuffer()))

    const error = await decryptToDirectory(envelope, outDir, asOwner()).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/malformed or unsafe to unpack/)
    // The leaf's CID is a hash of plaintext: it stays out of the message.
    expect((error as Error).message).not.toContain(leaf.cid.toString())
    expect((error as Error).cause).toHaveProperty('message', expect.stringMatching(/does not match its CID/))
    expect(existsSync(outDir)).toBe(false)
  })

  // ponytail: empty files with ~145-char names; ~1370 of them cross the 256 KiB HAMT threshold, so
  // 1300 stays a plain directory and 1450 shards. Asserting the type on both sides pins the threshold
  // itself, which a parity check alone cannot: both sides share the importer options.
  const manyEmptyFiles = (count: number) => async (path: string) => {
    await mkdir(path)
    for (let i = 0; i < count; i++) await writeFile(join(path, `${String(i).padStart(4, '0')}-${'n'.repeat(140)}`), '')
  }
  it.each([
    ['a file', 'file', async (path: string) => writeFile(path, randomBytes(1.5 * MiB))],
    [
      'a directory',
      'directory',
      async (path: string) => {
        await mkdir(join(path, 'sub'), { recursive: true })
        await writeFile(join(path, 'sub', 'x'), 'x')
        await writeFile(join(path, 'y'), randomBytes(1024))
      },
    ],
    // The two large cases write and pack ~1,400 files, which can exceed 5 s on slow CI runners.
    ['a large directory just under the HAMT threshold', 'directory', manyEmptyFiles(1300)],
    ['a directory just over the HAMT threshold', 'hamt-sharded-directory', manyEmptyFiles(1450)],
  ])(
    'wraps %s under the same CID an unencrypted add builds',
    async (_kind, type, build) => {
      await build(input)
      const plan = await planCarPayload(input)
      const wrapper = plan.nodes.get(plan.root.toString())
      if (wrapper == null) throw new Error('no wrapper node')
      const entry = dagPb.decode(wrapper.bytes).Links[0]?.Hash

      const { carPath, rootCid } = await createCarFromPath(input)
      await rm(carPath, { force: true })
      expect(entry?.toString()).toBe(rootCid.toString())
      const node = plan.nodes.get(rootCid.toString())
      const data = node == null ? undefined : dagPb.decode(node.bytes).Data
      expect(data == null ? undefined : UnixFS.unmarshal(data).type).toBe(type)
    },
    30_000
  )

  it('rejects another wallet and leaves nothing behind', async () => {
    await writeFile(input, randomBytes(MiB))
    await encryptPath(input, envelope, pieceKey())

    await expect(decryptToDirectory(envelope, outDir, ownerKeyResolver(STRANGER))).rejects.toThrow(/belongs to/)
    expect(existsSync(outDir)).toBe(false)
  })

  it('reports a modified file as such and leaves nothing behind', async () => {
    await writeFile(input, randomBytes(MiB))
    await encryptPath(input, envelope, pieceKey())
    const bytes = await readFile(envelope)
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01
    await writeFile(envelope, bytes)

    await expect(decryptToDirectory(envelope, outDir, asOwner())).rejects.toThrow(/modified/)
    expect(existsSync(outDir)).toBe(false)
  })

  it('reports an envelope without Keysmith labels as not ours', async () => {
    const { cek } = pieceKey()
    const foreign = new Blob([randomBytes(1024)])
      .stream()
      .pipeThrough(fee.encrypt({ cek, appMetadata: { kdf: 'pbkdf2-sha256' }, contentType: CAR_CONTENT_TYPE }))
    await writeFile(envelope, Buffer.from(await new Response(foreign).arrayBuffer()))

    await expect(decryptToDirectory(envelope, outDir, asOwner())).rejects.toThrow(
      'not encrypted by `filecoin-pin add --encrypt`'
    )
    expect(existsSync(outDir)).toBe(false)
  })

  it('restores beside existing entries, numbering a taken name', async () => {
    await writeFile(input, 'x')
    await encryptPath(input, envelope, pieceKey())
    await mkdir(outDir)
    await writeFile(join(outDir, 'input'), 'keep me')

    const result = await decryptToDirectory(envelope, outDir, asOwner())

    expect(result.path).toBe(join(outDir, 'input(1)'))
    expect(await readFile(join(outDir, 'input(1)'), 'utf8')).toBe('x')
    expect(await readFile(join(outDir, 'input'), 'utf8')).toBe('keep me')
  })

  it('rejects an envelope whose content type is not the CAR profile', async () => {
    const { cek, appMetadata } = pieceKey()
    const rawEnvelope = new Blob([randomBytes(1024)]).stream().pipeThrough(fee.encrypt({ cek, appMetadata }))
    await writeFile(envelope, Buffer.from(await new Response(rawEnvelope).arrayBuffer()))

    await expect(decryptToDirectory(envelope, outDir, asOwner())).rejects.toThrow(
      'not encrypted by `filecoin-pin add --encrypt`'
    )
    expect(existsSync(outDir)).toBe(false)
  })

  /** Seal a hand-made plaintext CAR (`root` first, then `rest`) as a valid envelope for the owner. */
  async function sealHandMade(root: { cid: CID; bytes: Uint8Array }, rest: { cid: CID; bytes: Uint8Array }[]) {
    const { writer, out } = CarWriter.create([root.cid])
    const drain = collect(out)
    for (const block of [root, ...rest]) await writer.put(block)
    await writer.close()
    const car = await drain
    const { cek, appMetadata } = pieceKey()
    const sealed = new Blob([new Uint8Array(car)])
      .stream()
      .pipeThrough(fee.encrypt({ cek, appMetadata, contentType: CAR_CONTENT_TYPE }))
    await writeFile(envelope, Buffer.from(await new Response(sealed).arrayBuffer()))
  }

  async function dagPbBlock(node: dagPb.PBNode): Promise<{ cid: CID; bytes: Uint8Array }> {
    const bytes = dagPb.encode(node)
    return { cid: CID.createV1(DAG_PB_CODEC, await sha256.digest(bytes)), bytes }
  }

  it.each([
    '../escape',
    '..\\..\\escape',
  ])('rejects a payload whose directory entry %s could escape the output directory', async (name) => {
    const leafBytes = new Uint8Array([1, 2, 3])
    const leaf = CID.createV1(RAW_CODEC, await sha256.digest(leafBytes))
    const root = await dagPbBlock({
      Data: new UnixFS({ type: 'directory' }).marshal(),
      Links: [{ Name: name, Hash: leaf, Tsize: leafBytes.length }],
    })
    await sealHandMade(root, [{ cid: leaf, bytes: leafBytes }])

    const error = await decryptToDirectory(envelope, outDir, asOwner()).catch((e: Error) => e)
    expect((error as Error).message).toMatch(/malformed or unsafe to unpack/)
    expect((error as Error).message).not.toContain(name)
    expect((error as Error).cause).toHaveProperty('message', expect.stringMatching(/unsafe entry name/))
    expect(existsSync(outDir)).toBe(false)
    expect(existsSync(join(dir, 'escape'))).toBe(false)
  })

  it('rejects a symlink entry without naming it or creating the link', async () => {
    const link = await dagPbBlock({
      Data: new UnixFS({ type: 'symlink', data: new TextEncoder().encode('/etc/passwd') }).marshal(),
      Links: [],
    })
    const root = await dagPbBlock({
      Data: new UnixFS({ type: 'directory' }).marshal(),
      Links: [{ Name: 'secret-link-name', Hash: link.cid, Tsize: link.bytes.length }],
    })
    await sealHandMade(root, [link])

    const error = await decryptToDirectory(envelope, outDir, asOwner()).catch((e: Error) => e)
    expect((error as Error).message).toMatch(/malformed or unsafe to unpack/)
    expect((error as Error).message).not.toContain('secret-link-name')
    expect((error as Error).cause).toHaveProperty('message', expect.stringMatching(/symlink entries/))
    expect(existsSync(outDir)).toBe(false)
  })

  it('never resolves a path outside the output directory', () => {
    expect(insideDir(outDir, 'a/b.txt')).toBe(join(outDir, 'a', 'b.txt'))
    expect(() => insideDir(outDir, '../escape')).toThrow(/outside the output directory/)
    expect(() => insideDir(outDir, 'a/../../escape')).toThrow(/outside the output directory/)
    expect(() => insideDir(outDir, '/etc/passwd')).toThrow(/outside the output directory/)
  })

  it('chunks files into 1 MiB raw leaves (unixfs-v1-2025), so the format stays readable', async () => {
    await writeFile(input, randomBytes(2.5 * MiB))

    const plan = await planCarPayload(input)

    expect(plan.layout.leaves.map((leaf) => leaf.len)).toEqual([MiB, MiB, 0.5 * MiB])
    expect(plan.layout.leaves.every((leaf) => leaf.cid.code === RAW_CODEC)).toBe(true)
  })
})
