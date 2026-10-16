import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CarBlockIterator, CarWriter } from '@ipld/car'
import * as dagPb from '@ipld/dag-pb'
import * as fee from 'filecoin-encryption-envelope'
import { UnixFS } from 'ipfs-unixfs'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decryptToDirectory, derivePasswordKey, encryptPathWithPassword } from '../../common/encryption.js'
import { CAR_CONTENT_TYPE, DAG_PB_CODEC, decodeVarint, RAW_CODEC } from '../../common/unixfs-car-layout.js'
import { emitCarPayload, planCarPayload } from '../../common/unixfs-car-payload.js'

const PASSWORD = 'correct horse battery staple'
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

    await encryptPathWithPassword(input, envelope, PASSWORD)
    const result = await decryptToDirectory(envelope, outDir, PASSWORD)

    expect(result).toEqual({ files: 1, dirs: 0, bytes: content.length })
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

    const { plan } = await encryptPathWithPassword(input, envelope, PASSWORD)
    const result = await decryptToDirectory(envelope, outDir, PASSWORD)

    expect(plan.walk.skippedSymlinks).toEqual(['input/docs/evil'])
    expect(result.files).toBe(4)
    expect((await readFile(join(outDir, 'input', 'big.bin'))).equals(big)).toBe(true)
    expect(await readFile(join(outDir, 'input', 'docs', 'a.txt'), 'utf8')).toBe('a')
    expect(await readFile(join(outDir, 'input', 'docs', 'deeper', longName), 'utf8')).toBe('deep')
    expect(await readFile(join(outDir, 'input', 'docs', 'empty.txt'), 'utf8')).toBe('')
    expect((await stat(join(outDir, 'input', 'empty-dir'))).isDirectory()).toBe(true)
    expect(existsSync(join(outDir, 'input', 'docs', 'evil'))).toBe(false)
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

    await encryptPathWithPassword(input, envelope, PASSWORD)
    await decryptToDirectory(envelope, outDir, PASSWORD)
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

  it('fails if a file changes between the two passes', async () => {
    await writeFile(input, randomBytes(MiB))
    const plan = await planCarPayload(input)
    await writeFile(input, randomBytes(MiB))

    await expect(collect(emitCarPayload(plan))).rejects.toThrow(/changed during encryption/)
  })

  it('rejects the wrong password and leaves nothing behind', async () => {
    await writeFile(input, randomBytes(MiB))
    await encryptPathWithPassword(input, envelope, PASSWORD)

    await expect(decryptToDirectory(envelope, outDir, 'wrong password')).rejects.toThrow(/wrong password/i)
    expect(existsSync(outDir)).toBe(false)
  })

  it('refuses an existing output directory', async () => {
    await writeFile(input, 'x')
    await encryptPathWithPassword(input, envelope, PASSWORD)
    await mkdir(outDir)

    await expect(decryptToDirectory(envelope, outDir, PASSWORD)).rejects.toThrow(/already exists/)
  })

  it('rejects an envelope whose content type is not the CAR profile', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const cek = await derivePasswordKey(PASSWORD, salt, 600_000)
    const appMetadata = { kdf: 'pbkdf2-sha256', iterations: 600_000, salt: Buffer.from(salt).toString('base64') }
    const rawEnvelope = new Blob([randomBytes(1024)]).stream().pipeThrough(fee.encrypt({ cek, appMetadata }))
    await writeFile(envelope, Buffer.from(await new Response(rawEnvelope).arrayBuffer()))

    await expect(decryptToDirectory(envelope, outDir, PASSWORD)).rejects.toThrow(
      'not encrypted by `filecoin-pin add --encrypt`'
    )
    expect(existsSync(outDir)).toBe(false)
  })

  it('rejects a payload whose directory entry could escape the output directory', async () => {
    const leafBytes = new Uint8Array([1, 2, 3])
    const leaf = CID.createV1(RAW_CODEC, await sha256.digest(leafBytes))
    const dirNode = dagPb.encode({
      Data: new UnixFS({ type: 'directory' }).marshal(),
      Links: [{ Name: '../escape', Hash: leaf, Tsize: leafBytes.length }],
    })
    const root = CID.createV1(DAG_PB_CODEC, await sha256.digest(dirNode))
    const { writer, out } = CarWriter.create([root])
    const drain = collect(out)
    await writer.put({ cid: root, bytes: dirNode })
    await writer.put({ cid: leaf, bytes: leafBytes })
    await writer.close()
    const car = await drain
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const cek = await derivePasswordKey(PASSWORD, salt, 600_000)
    const appMetadata = { kdf: 'pbkdf2-sha256', iterations: 600_000, salt: Buffer.from(salt).toString('base64') }
    const hostile = new Blob([new Uint8Array(car)])
      .stream()
      .pipeThrough(fee.encrypt({ cek, appMetadata, contentType: CAR_CONTENT_TYPE }))
    await writeFile(envelope, Buffer.from(await new Response(hostile).arrayBuffer()))

    await expect(decryptToDirectory(envelope, outDir, PASSWORD)).rejects.toThrow(/unsafe entry name/)
    expect(existsSync(outDir)).toBe(false)
    expect(existsSync(join(dir, 'escape'))).toBe(false)
  })
})
