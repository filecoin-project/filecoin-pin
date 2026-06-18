import { Readable } from 'node:stream'
import { CarWriter } from '@ipld/car'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { describe, expect, it } from 'vitest'
import { carInputError, INPUT_IS_CAR, isCar } from '../../core/car/is-car.js'

async function buildCar(roots: CID[], blocks: { cid: CID; bytes: Uint8Array }[]): Promise<Uint8Array> {
  const { writer, out } = CarWriter.create(roots)
  const chunks: Uint8Array[] = []
  const drain = (async () => {
    for await (const c of out) chunks.push(c)
  })()
  for (const block of blocks) {
    await writer.put(block)
  }
  await writer.close()
  await drain
  return Buffer.concat(chunks)
}

const cidA = CID.create(1, raw.code, await sha256.digest(new TextEncoder().encode('hello')))
const cidB = CID.create(1, raw.code, await sha256.digest(new TextEncoder().encode('world')))

const validSingleRoot = await buildCar([cidA], [{ cid: cidA, bytes: new TextEncoder().encode('hello') }])
const validMultiRoot = await buildCar(
  [cidA, cidB],
  [
    { cid: cidA, bytes: new TextEncoder().encode('hello') },
    { cid: cidB, bytes: new TextEncoder().encode('world') },
  ]
)
// Header-only: roots declared but no blocks written. Detection only inspects the header.
const headerOnly = await buildCar([cidA], [])
const garbage = new Uint8Array(64).fill(0xff)
const text = new TextEncoder().encode('this is a plain text file, not a CAR\n')
const empty = new Uint8Array(0)

describe('isCar', () => {
  it.each([
    { description: 'valid CAR with single root', data: validSingleRoot, expected: true },
    { description: 'valid CAR with multiple roots', data: validMultiRoot, expected: true },
    { description: 'CAR header with no blocks', data: headerOnly, expected: true },
    { description: 'plain text', data: text, expected: false },
    { description: 'binary garbage', data: garbage, expected: false },
    { description: 'empty input', data: empty, expected: false },
  ])('returns $expected for $description', async ({ data, expected }) => {
    expect(await isCar(Readable.from(data))).toBe(expected)
  })

  it('accepts a Web ReadableStream', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(validSingleRoot)
        controller.close()
      },
    })
    expect(await isCar(stream)).toBe(true)
  })

  it('does not consume the entire source', async () => {
    // Increment BEFORE each yield so `pulls` counts iterator advances, not
    // post-yield resumes.
    let pulls = 0
    async function* trickle() {
      pulls++
      yield validSingleRoot
      pulls++
      yield new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    }
    expect(await isCar(trickle())).toBe(true)
    expect(pulls).toBe(1)
  })
})

describe('carInputError', () => {
  it('tags the error with INPUT_IS_CAR', () => {
    const err = carInputError('/tmp/foo.car')
    expect(err.code).toBe(INPUT_IS_CAR)
    expect(err.message).toContain('/tmp/foo.car')
    expect(err.message).toContain('appears to be')
    expect(err.message).toContain('filecoin-pin import')
  })
})
