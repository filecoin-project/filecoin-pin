import { newSalt, type PieceMetadata, pieceMetadata } from '@filoz/keysmith'
import * as dagPb from '@ipld/dag-pb'
import * as fee from 'filecoin-encryption-envelope'
import { UnixFS } from 'ipfs-unixfs'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { describe, expect, it } from 'vitest'
import { EnvelopeLabelsError, readEnvelopeLabels } from '../../common/envelope-labels.js'
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
    const labels = pieceMetadata({ owner: OWNER, keyspace: GROUP_KEY }, { salt: newSalt() })
    const leaf = await envelope(labels)
    const root = await rawCid(leaf)
    const fetchImpl = fakeFetch({ 'https://good.test': new Map([[root.toString(), leaf]]) })
    expect(await readEnvelopeLabels(root, ['https://good.test'], fetchImpl)).toEqual(labels)
  })

  it('walks a dag-pb root to its first leaf', async () => {
    const labels = pieceMetadata({ owner: OWNER, keyspace: GROUP_KEY }, { salt: newSalt() })
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
    const mine = pieceMetadata({ owner: OWNER, keyspace: GROUP_KEY }, { salt: newSalt() })
    const other = pieceMetadata({ owner: OWNER, keyspace: GROUP_KEY }, { salt: newSalt() })
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

  it('says so when no provider has it, or the file is not an encrypted upload', async () => {
    const plain = new TextEncoder().encode('just a file')
    const root = await rawCid(plain)
    const fetchImpl = fakeFetch({ 'https://good.test': new Map([[root.toString(), plain]]) })
    await expect(readEnvelopeLabels(root, [], fetchImpl)).rejects.toBeInstanceOf(EnvelopeLabelsError)
    await expect(readEnvelopeLabels(root, ['https://good.test'], fetchImpl)).rejects.toThrow(/no FEE envelope header/)
  })
})
