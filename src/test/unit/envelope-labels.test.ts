import { newSalt, type PieceMetadata, pieceMetadata } from '@filoz/keysmith'
import { CarWriter } from '@ipld/car/writer'
import * as dagPb from '@ipld/dag-pb'
import * as fee from 'filecoin-encryption-envelope'
import { UnixFS } from 'ipfs-unixfs'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { describe, expect, it } from 'vitest'
import {
  EnvelopeLabelsError,
  NotEncryptedUploadError,
  privateEnvelopeLabels,
  readEnvelopeLabels,
} from '../../common/envelope-labels.js'
import { CAR_CONTENT_TYPE } from '../../common/unixfs-car-layout.js'

const OWNER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' as const
const GROUP_KEY = '0x02ca08cf7e0222c8432adc159232b7eb' as const

/** A real `add --encrypt`-style envelope: FEE over a small payload, with Keysmith labels. */
async function envelope(labels: PieceMetadata): Promise<Uint8Array> {
  const plaintext = new TextEncoder().encode('an inner CAR would go here')
  const stream = new Blob([plaintext]).stream().pipeThrough(
    fee.encrypt({
      cek: crypto.getRandomValues(new Uint8Array(32)),
      contentLength: plaintext.length,
      contentType: CAR_CONTENT_TYPE,
      appMetadata: labels,
    })
  )
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const rawCid = async (bytes: Uint8Array) => CID.create(1, raw.code, await sha256.digest(bytes))

/** A dag-pb UnixFS file node linking to one raw leaf, as a multi-block upload's root is. */
async function fileRoot(leaf: CID, size: number): Promise<{ cid: CID; bytes: Uint8Array }> {
  const bytes = dagPb.encode({
    Data: new UnixFS({ type: 'file', blockSizes: [BigInt(size)] }).marshal(),
    Links: [{ Hash: leaf, Tsize: size }],
  })
  return { cid: CID.create(1, dagPb.code, await sha256.digest(bytes)), bytes }
}

/** A fetch that serves blocks per provider: `blocks[provider][cid]`. */
function fakeFetch(blocks: Record<string, Map<string, Uint8Array>>): typeof fetch {
  return (async (url: string) => {
    const { origin, pathname } = new URL(url)
    const bytes = blocks[origin]?.get(pathname.replace('/ipfs/', ''))
    return bytes == null ? new Response(null, { status: 404 }) : new Response(new Uint8Array(bytes))
  }) as typeof fetch
}

describe('readEnvelopeLabels', () => {
  it('reads the labels of a single-block upload (a raw root)', async () => {
    const labels = pieceMetadata({ owner: OWNER, groupKeyId: GROUP_KEY }, { salt: newSalt() })
    const leaf = await envelope(labels)
    const root = await rawCid(leaf)
    const fetchImpl = fakeFetch({ 'https://good.test': new Map([[root.toString(), leaf]]) })
    expect(await readEnvelopeLabels(root, ['https://good.test'], fetchImpl)).toEqual(labels)
  })

  it('walks a dag-pb root to its first leaf', async () => {
    const labels = pieceMetadata({ owner: OWNER, groupKeyId: GROUP_KEY }, { salt: newSalt() })
    const leaf = await envelope(labels)
    const leafCid = await rawCid(leaf)
    const root = await fileRoot(leafCid, leaf.length)
    const fetchImpl = fakeFetch({
      'https://good.test': new Map([
        [root.cid.toString(), root.bytes],
        [leafCid.toString(), leaf],
      ]),
    })
    expect(await readEnvelopeLabels(root.cid, ['https://good.test'], fetchImpl)).toEqual(labels)
  })

  it("refuses a provider that serves another upload's header for this CID, and uses the next", async () => {
    const mine = pieceMetadata({ owner: OWNER, groupKeyId: GROUP_KEY }, { salt: newSalt() })
    const other = pieceMetadata({ owner: OWNER, groupKeyId: GROUP_KEY }, { salt: newSalt() })
    const leaf = await envelope(mine)
    const root = await rawCid(leaf)
    const fetchImpl = fakeFetch({
      // The swap that a plain byte-range read could not detect: another upload's bytes under my CID.
      'https://evil.test': new Map([[root.toString(), await envelope(other)]]),
      'https://good.test': new Map([[root.toString(), leaf]]),
    })
    expect(await readEnvelopeLabels(root, ['https://evil.test', 'https://good.test'], fetchImpl)).toEqual(mine)
    await expect(readEnvelopeLabels(root, ['https://evil.test'], fetchImpl)).rejects.toThrow(/does not match its CID/)
  })

  it('says so when no provider has it', async () => {
    const root = await rawCid(new TextEncoder().encode('just a file'))
    await expect(readEnvelopeLabels(root, [], fakeFetch({}))).rejects.toBeInstanceOf(EnvelopeLabelsError)
  })

  it.each([
    [
      'a plain file',
      async () => {
        const plain = new TextEncoder().encode('just a file')
        const root = await rawCid(plain)
        return { root, blocks: new Map([[root.toString(), plain]]) }
      },
    ],
    [
      'a folder',
      async () => {
        const bytes = dagPb.encode({ Data: new UnixFS({ type: 'directory' }).marshal(), Links: [] })
        const root = CID.create(1, dagPb.code, await sha256.digest(bytes))
        return { root, blocks: new Map([[root.toString(), bytes]]) }
      },
    ],
  ])('says %s is plain content, without trying another provider', async (_, make) => {
    const { root, blocks } = await make()
    const asked: string[] = []
    const serve = fakeFetch({ 'https://good.test': blocks })
    const fetchImpl = (async (url: string) => {
      asked.push(new URL(url).origin)
      return serve(url)
    }) as typeof fetch

    const error = await readEnvelopeLabels(root, ['https://good.test', 'https://other.test'], fetchImpl).catch(
      (e: unknown) => e
    )

    expect(error).toBeInstanceOf(NotEncryptedUploadError)
    expect((error as Error).message).toBe(
      `${root} is plain content, not an upload made with \`add --encrypt\`: anyone can open it by its CID, so it doesn't need a Share link`
    )
    // The blocks were verified, so the next provider would serve the same.
    expect(asked).not.toContain('https://other.test')
  })

  it('says an envelope without Keysmith labels was not made by add --encrypt', async () => {
    const leaf = await envelope({} as PieceMetadata)
    const root = await rawCid(leaf)
    const fetchImpl = fakeFetch({ 'https://good.test': new Map([[root.toString(), leaf]]) })
    await expect(readEnvelopeLabels(root, ['https://good.test'], fetchImpl)).rejects.toThrow(
      `${root} is encrypted, but not by \`add --encrypt\`, so a Share link cannot open it`
    )
  })

  it('still moves on from a provider that fails to serve the blocks', async () => {
    const labels = pieceMetadata({ owner: OWNER, groupKeyId: GROUP_KEY }, { salt: newSalt() })
    const leaf = await envelope(labels)
    const root = await rawCid(leaf)
    const fetchImpl = fakeFetch({ 'https://good.test': new Map([[root.toString(), leaf]]) })
    expect(await readEnvelopeLabels(root, ['https://missing.test', 'https://good.test'], fetchImpl)).toEqual(labels)
  })
})

/** A CAR laid out as `add` writes the outer one: leaves first, in file order, then the root. */
async function carOf(root: CID, blocks: Array<{ cid: CID; bytes: Uint8Array }>): Promise<Uint8Array> {
  const { writer, out } = CarWriter.create([root as never])
  const collected = new Response(
    new ReadableStream({
      async start(controller) {
        for await (const chunk of out) controller.enqueue(chunk)
        controller.close()
      },
    })
  ).arrayBuffer()
  for (const block of blocks) await writer.put(block as never)
  await writer.close()
  return new Uint8Array(await collected)
}

/** Serves `bytes=0-N` and `bytes=-N` of `car`, recording what was asked. */
function rangesOf(car: Uint8Array, asked: string[]) {
  return async (range: string): Promise<Uint8Array> => {
    asked.push(range)
    const head = range.match(/^bytes=0-(\d+)$/)
    if (head != null) return car.subarray(0, Number(head[1]) + 1)
    const tail = range.match(/^bytes=-(\d+)$/)
    if (tail != null) return car.subarray(Math.max(0, car.length - Number(tail[1])))
    throw new Error(`unexpected range ${range}`)
  }
}

describe('privateEnvelopeLabels', () => {
  const labels = () => pieceMetadata({ owner: OWNER, groupKeyId: GROUP_KEY }, { salt: newSalt() })

  it('reads a multi-block upload from the head and the tail, verified against the root', async () => {
    const mine = labels()
    const leaf = await envelope(mine)
    const leafCid = await rawCid(leaf)
    // A second leaf bigger than the tail read, so the root is found inside a partial tail.
    const rest = crypto.getRandomValues(new Uint8Array(60_000))
    const big = new Uint8Array(200_000)
    for (let i = 0; i < big.length; i += rest.length) big.set(rest.subarray(0, big.length - i), i)
    const bigCid = await rawCid(big)
    const rootBytes = dagPb.encode({
      Data: new UnixFS({ type: 'file', blockSizes: [BigInt(leaf.length), BigInt(big.length)] }).marshal(),
      Links: [
        { Hash: leafCid, Tsize: leaf.length },
        { Hash: bigCid, Tsize: big.length },
      ],
    })
    const root = CID.create(1, dagPb.code, await sha256.digest(rootBytes))
    const car = await carOf(root, [
      { cid: leafCid, bytes: leaf },
      { cid: bigCid, bytes: big },
      { cid: root, bytes: rootBytes },
    ])

    const asked: string[] = []
    expect(await privateEnvelopeLabels(root, rangesOf(car, asked))).toEqual(mine)
    // The head and the tail only, never the whole piece.
    expect(asked).toEqual([expect.stringMatching(/^bytes=0-/), expect.stringMatching(/^bytes=-/)])
  })

  it('reads a one-block upload (a raw root) from the head alone', async () => {
    const mine = labels()
    const leaf = await envelope(mine)
    const root = await rawCid(leaf)
    const asked: string[] = []
    expect(await privateEnvelopeLabels(root, rangesOf(await carOf(root, [{ cid: root, bytes: leaf }]), asked))).toEqual(
      mine
    )
    expect(asked).toHaveLength(1)
  })

  it("refuses a piece whose first block is another upload's header", async () => {
    const leaf = await envelope(labels())
    const leafCid = await rawCid(leaf)
    const root = await fileRoot(leafCid, leaf.length)
    // The swap: another upload's leaf where mine should be, with its own (valid) CID.
    const other = await envelope(labels())
    const car = await carOf(root.cid, [
      { cid: await rawCid(other), bytes: other },
      { cid: root.cid, bytes: root.bytes },
    ])
    await expect(privateEnvelopeLabels(root.cid, rangesOf(car, []))).rejects.toThrow(/neither the first nor the last/)
  })
})
