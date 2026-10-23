import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CarWriter } from '@ipld/car'
import * as dagPb from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type CarLayout, DAG_PB_CODEC, RAW_CODEC } from '../../common/unixfs-car-layout.js'
import { type CarPayloadPlan, emitCarPayload, planCarPayload } from '../../common/unixfs-car-payload.js'
import { unpackCar } from '../../common/unixfs-car-unpack.js'

// Lets one test hand unpackCar a layout whose names skipped the layout's own check,
// so only unpackCar's containment check stands between the payload and the disk.
const hostile = vi.hoisted(() => ({ rename: undefined as undefined | ((path: string) => string) }))
vi.mock('../../common/unixfs-car-layout.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/unixfs-car-layout.js')>()
  return {
    ...actual,
    layout: (...args: Parameters<typeof actual.layout>): CarLayout => {
      const lay = actual.layout(...args)
      const rename = hostile.rename
      if (rename == null) return lay
      for (const leaf of lay.leaves) {
        for (const target of leaf.targets) target.path = rename(target.path)
      }
      return { ...lay, files: new Map([...lay.files].map(([path, placement]) => [rename(path), placement])) }
    },
  }
})

async function collect(gen: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const chunk of gen) parts.push(chunk)
  return Buffer.concat(parts)
}

const stream = (bytes: Uint8Array): ReadableStream<Uint8Array> => new Blob([new Uint8Array(bytes)]).stream()

/** A CAR of a wrapper directory holding raw-leaf files under the given names, written in `order`. */
async function handMadeCar(names: string[], order: 'metadata-first' | 'pb-after-raw' = 'metadata-first') {
  const leaves = await Promise.all(
    names.map(async (_, i) => {
      const bytes = new Uint8Array([i, 1, 2, 3])
      return { bytes, cid: CID.createV1(RAW_CODEC, await sha256.digest(bytes)) }
    })
  )
  const dirNode = dagPb.encode({
    Data: new UnixFS({ type: 'directory' }).marshal(),
    Links: names.map((Name, i) => ({ Name, Hash: leaves[i]?.cid as CID, Tsize: 4 })),
  })
  const root = CID.createV1(DAG_PB_CODEC, await sha256.digest(dirNode))
  const extraNode = dagPb.encode({ Data: new UnixFS({ type: 'directory' }).marshal(), Links: [] })
  const extra = CID.createV1(DAG_PB_CODEC, await sha256.digest(extraNode))
  const { writer, out } = CarWriter.create([root])
  const drain = collect(out)
  await writer.put({ cid: root, bytes: dirNode })
  for (const leaf of leaves) await writer.put(leaf)
  if (order === 'pb-after-raw') await writer.put({ cid: extra, bytes: extraNode })
  await writer.close()
  return drain
}

describe('unpackCar', () => {
  let dir: string
  let outDir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'filecoin-pin-unpack-'))
    outDir = join(dir, 'out')
    await mkdir(outDir)
  })

  afterEach(async () => {
    hostile.rename = undefined
    await rm(dir, { recursive: true, force: true })
  })

  /** The real metadata-first CAR of a directory holding `count` distinct small files. */
  async function realCar(count: number): Promise<{ car: Uint8Array; plan: CarPayloadPlan }> {
    const input = join(dir, 'input')
    await mkdir(input)
    for (let i = 0; i < count; i++) await writeFile(join(input, `f${String(i).padStart(2, '0')}`), randomBytes(1024))
    const plan = await planCarPayload(input)
    return { car: await collect(emitCarPayload(plan)), plan }
  }

  // More leaves than the verification window (8), so corruption is seen both inside and after the window.
  it.each([0, 5, 11])('rejects a corrupted same-length leaf #%i without an unhandled rejection', async (index) => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const { car, plan } = await realCar(12)
      const leaf = plan.layout.leaves[index]
      if (leaf == null) throw new Error('no such leaf')
      const corrupted = new Uint8Array(car)
      corrupted[leaf.dataOffset] = (corrupted[leaf.dataOffset] ?? 0) ^ 0xff

      await expect(unpackCar(stream(corrupted), outDir)).rejects.toThrow(/does not match its CID/)
      await new Promise((resolve) => setImmediate(resolve))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('rejects a dag-pb block after the first raw leaf', async () => {
    await expect(unpackCar(stream(await handMadeCar(['a'], 'pb-after-raw')), outDir)).rejects.toThrow(
      /not metadata-first/
    )
  })

  it.each([1, 2])('rejects a payload missing its last %i leaves', async (missing) => {
    const { car, plan } = await realCar(4)
    const cut = plan.layout.leaves[plan.layout.leaves.length - missing]?.offset
    await expect(unpackCar(stream(car.subarray(0, cut)), outDir)).rejects.toThrow(/truncated payload/)
  })

  it('rejects two entries with the same path', async () => {
    await expect(unpackCar(stream(await handMadeCar(['a', 'a'])), outDir)).rejects.toThrow(/duplicate path a/)
  })

  it('writes beside a file that already has the name, under a numbered name', async () => {
    await writeFile(join(outDir, 'a'), 'keep me')
    const claimed = vi.fn()

    const result = await unpackCar(stream(await handMadeCar(['a'])), outDir, claimed)

    expect(result.path).toBe(join(outDir, 'a (1)'))
    expect(claimed).toHaveBeenCalledWith(join(outDir, 'a (1)'))
    expect(await readFile(join(outDir, 'a'), 'utf8')).toBe('keep me')
    expect([...(await readFile(join(outDir, 'a (1)')))]).toEqual([0, 1, 2, 3])
  })

  it('rejects a wrapper holding more than one entry before claiming anything', async () => {
    await expect(unpackCar(stream(await handMadeCar(['a', 'b'])), outDir)).rejects.toThrow(/exactly one entry/)
    expect(await readdir(outDir)).toEqual([])
  })

  it.each(['..', '.', '', 'a\0b', 'a/b', '..\\escape'])('rejects the entry name %j', async (name) => {
    await expect(unpackCar(stream(await handMadeCar([name])), outDir)).rejects.toThrow(/unsafe entry name/)
    expect(await readdir(outDir)).toEqual([])
  })

  it('refuses a path that resolves outside the output directory even when the name check is bypassed', async () => {
    hostile.rename = (path) => `../${path}`
    await expect(unpackCar(stream(await handMadeCar(['escape'])), outDir)).rejects.toThrow(
      /outside the output directory/
    )
    expect(existsSync(join(dir, 'escape'))).toBe(false)
  })
})
