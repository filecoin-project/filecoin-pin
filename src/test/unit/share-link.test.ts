import { readFileSync } from 'node:fs'
import {
  decodeDelivery,
  decodeGrant,
  deriveGroupKey,
  keyForEnvelope,
  newSalt,
  type PieceMetadata,
  pieceMetadata,
  verifyPresentation,
} from '@filoz/keysmith'
import { CID } from 'multiformats/cid'
import { bytesToHex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { describe, expect, it, vi } from 'vitest'
import { openGroupKeyGrant } from '../../common/group-key-grant.js'
import {
  accessKeyText,
  createShare,
  formatShareLink,
  parseAccessKey,
  parseShareLink,
  type ShareSender,
  shareDownload,
  shareKey,
  shareKeyResolver,
  shareOwner,
} from '../../common/share-link.js'
import {
  CALIBRATION_CHAIN_ID,
  GROUP_KEY,
  makeGrant,
  OWNER,
  SESSION_KEY,
  STRANGER_KEY,
} from '../fixtures/group-key-grants.js'

const ROOT = CID.parse('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')
const VIEWER = 'https://viewer.test/'

const labelsFor = (salt = newSalt(), group?: string): PieceMetadata =>
  pieceMetadata({ owner: OWNER.address, groupKeyId: GROUP_KEY }, { salt, ...(group != null && { group }) })

/** The upload's key as the owner derives it: what every share must open to. */
async function ownerPieceKey(labels: PieceMetadata): Promise<string> {
  const { groupKey: kk } = await deriveGroupKey(OWNER, { owner: OWNER.address, groupKeyId: GROUP_KEY })
  return bytesToHex(keyForEnvelope(kk, labels))
}

async function sessionSender(): Promise<ShareSender> {
  const text = await makeGrant()
  const grant = await openGroupKeyGrant(text, {
    sessionKey: SESSION_KEY,
    walletAddress: OWNER.address,
    chainId: CALIBRATION_CHAIN_ID,
  })
  return { grants: [grant] }
}

/** Open a created share as a recipient would, and return the key it gives for `labels`. */
async function open(link: string, accessKey: string | undefined, labels: PieceMetadata) {
  const parsed = parseShareLink(link)
  const key = await shareKeyResolver(parsed, shareKey(parsed, accessKey))({ appMetadata: labels } as never)
  return bytesToHex(key)
}

describe('share link text', () => {
  it('round-trips each mode, and ignores a fragment already on the viewer URL', () => {
    const payload = new Uint8Array([0x83, 1, 2, 3])
    const key = generatePrivateKey()
    for (const accessKey of [undefined, key]) {
      const link = formatShareLink(`${VIEWER}#old`, ROOT, payload, accessKey)
      expect(link.startsWith(`${VIEWER}#v1/${ROOT}&d=`)).toBe(true)
      const parsed = parseShareLink(link)
      expect(parsed.rootCid.equals(ROOT)).toBe(true)
      expect(parsed.payload).toEqual(payload)
      expect(parsed.accessKey).toEqual(accessKey)
    }
    expect(parseAccessKey(accessKeyText(key))).toBe(key)
  })

  it('refuses a wrong paste with a specific error', () => {
    const link = formatShareLink(VIEWER, ROOT, new Uint8Array([0x83]))
    expect(() => parseAccessKey('fgr1_abc')).toThrow(/group key Grant/)
    expect(() => parseAccessKey(link)).toThrow(/Share link, not an Access key/)
    expect(() => parseShareLink(accessKeyText(generatePrivateKey()))).toThrow(/Access key, not a Share link/)
    expect(() => parseShareLink(`${VIEWER}#v1/${ROOT}`)).toThrow(/incomplete/)
    expect(() => parseShareLink(`${link}&z=1`)).toThrow(/unexpected part "z"/)
    expect(() => parseShareLink(`${VIEWER}#v2/${ROOT}&d=gw`)).toThrow(/Not a v1 Share link/)
    // Password shares are not part of v1.
    expect(() => parseShareLink(`${link}&p=pw1.AAECAwQFBgcICQoLDA0ODw`)).toThrow(/unexpected part "p"/)
  })
})

describe('createShare', () => {
  it('restricted mode: a link the Access key opens, and nothing else does', async () => {
    const labels = labelsFor()
    const share = await createShare({
      sender: { owner: OWNER },
      rootCid: ROOT,
      labels,
      mode: 'restricted',
      viewer: VIEWER,
    })
    expect(share.link).not.toContain('&k=')
    expect(await open(share.link, share.accessKey, labels)).toBe(await ownerPieceKey(labels))
    // The link alone, or another key, opens nothing.
    await expect(open(share.link, undefined, labels)).rejects.toThrow(/needs its Access key/)
    await expect(open(share.link, accessKeyText(generatePrivateKey()), labels)).rejects.toThrow(
      /does not open this share/
    )
    // One upload only: another piece of the same group key is refused.
    await expect(open(share.link, share.accessKey, labelsFor())).rejects.toThrow(/another upload/)
  })

  it('open mode: the link opens on its own', async () => {
    const labels = labelsFor()
    const share = await createShare({
      sender: { owner: OWNER },
      rootCid: ROOT,
      labels,
      mode: 'open',
      viewer: VIEWER,
    })
    expect(share.accessKey).toBeUndefined()
    expect(share.link).toContain('&k=fak1_')
    expect(await open(share.link, undefined, labels)).toBe(await ownerPieceKey(labels))
  })

  it('refuses to share an upload of another owner', async () => {
    const labels = pieceMetadata(
      { owner: '0x0000000000000000000000000000000000000001', groupKeyId: GROUP_KEY },
      { salt: newSalt() }
    )
    await expect(
      createShare({
        sender: { owner: OWNER },
        rootCid: ROOT,
        labels,
        mode: 'restricted',
      })
    ).rejects.toThrow(/belongs to 0x0000000000000000000000000000000000000001/)
  })

  it("a session key shares with its Grant's group key", async () => {
    const labels = labelsFor()
    const share = await createShare({
      sender: await sessionSender(),
      rootCid: ROOT,
      labels,
      mode: 'restricted',
      viewer: VIEWER,
    })
    expect(await open(share.link, share.accessKey, labels)).toBe(await ownerPieceKey(labels))
    // A stranger's share key cannot stand in for the Access key.
    await expect(open(share.link, accessKeyText(STRANGER_KEY), labels)).rejects.toThrow(/does not open this share/)
  })
})

interface OpeningVector {
  name: string
  link: string
  accessKey?: string
}
const vectors = JSON.parse(readFileSync(new URL('../fixtures/share-link-vectors.json', import.meta.url), 'utf8')) as {
  labels: PieceMetadata
  pieceKey: string
  opening: OpeningVector[]
}

describe('pinned vectors', () => {
  // Expected values computed independently (Python's base64.urlsafe_b64encode, padding stripped).
  const PAYLOAD = new Uint8Array([0x83, 1, 2, 3])
  const KEY = bytesToHex(Uint8Array.from({ length: 32 }, (_, i) => i + 1))
  const FRAGMENT = `${VIEWER}#v1/${ROOT}&d=gwECAw`

  it.each([
    ['restricted', undefined, FRAGMENT],
    ['open', KEY, `${FRAGMENT}&k=fak1_AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA`],
  ])('formats and parses the %s link form exactly', (_, accessKey, link) => {
    expect(formatShareLink(VIEWER, ROOT, PAYLOAD, accessKey)).toBe(link)
    expect(parseShareLink(link)).toEqual({ rootCid: ROOT, payload: PAYLOAD, ...(accessKey != null && { accessKey }) })
  })

  // Made on 2026-11-18 (keysmith format 2) by createShare (owner: Anvil #0; GROUP_KEY; salt 00..0f; bearers
  // random). Links already sent must keep opening: a change to the link or the grant must
  // show up here, not get regenerated.
  it('derives the pinned piece key from the vector labels', async () => {
    expect(await ownerPieceKey(vectors.labels)).toBe(vectors.pieceKey)
  })

  it.each(vectors.opening)('opens "$name" to the pinned piece key', { timeout: 30_000 }, async (vector) => {
    const parsed = parseShareLink(vector.link)
    expect(parsed.rootCid.equals(ROOT)).toBe(true)
    const T = shareKey(parsed, vector.accessKey)
    const key = await shareKeyResolver(parsed, T)({ appMetadata: vectors.labels } as never)
    expect(bytesToHex(key)).toBe(vectors.pieceKey)
  })
})

describe('a share link from filecoin-pin 2.3 or 2.4 (keysmith 0.1.0)', () => {
  it('says it is no longer readable, not that the Access key is wrong', async () => {
    const parsed = parseShareLink(
      'https://viewer.test/#v1/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi&d=pwABAXgocGllY2U6MHgwMDAxMDIwMzA0MDUwNjA3MDgwOTBhMGIwYzBkMGUwZgJU85_W5RqtiPb0zmq4gnJ5z_-5ImYDUALKCM9-AiLIQyrcFZIyt-sEWEEEbM60TnCFAJPv1N3nGck4lS5U65RKTOQMeKo0vrEUp1nfjDdtw1sx3wG82jhhCQnIymF2g28piHdYI4O9FX-FzwVMbvHPgHT5gdVTJdbrBlgwPwGfuNJ1BsUhPuxgitHPGO7k3hsEnNfXfn6k60dzF-3dwlbs8fsBEUiq54dDh2q5&k=fak1_NriZvJuvxjbKLvUb9ExS2AqO2kkVNDGuh3zW1LM9hpM'
    )
    await expect(shareOwner(parsed, shareKey(parsed, undefined))).rejects.toThrow(
      /keysmith 0\.1\.0 \(format 1\) data is not supported/
    )
  })
})

describe('Grant keys', () => {
  it('are zeroed even when the labels are refused before any key is used', async () => {
    const opened = await openGroupKeyGrant(await makeGrant(), {
      sessionKey: SESSION_KEY,
      walletAddress: OWNER.address,
      chainId: CALIBRATION_CHAIN_ID,
    })
    const bad = { ...labelsFor(), 'foc/salt': 'not hex' } as unknown as PieceMetadata

    await expect(
      createShare({ sender: { grants: [opened] }, rootCid: ROOT, labels: bad, mode: 'open' })
    ).rejects.toThrow()
    expect(opened.key.every((byte) => byte === 0)).toBe(true)
  })
})

describe('shares from a session key holding group Grants', () => {
  const groupSender = async (...nodes: string[]): Promise<ShareSender> => ({
    grants: await Promise.all(
      nodes.map(async (node) =>
        openGroupKeyGrant(await makeGrant({ node }), {
          sessionKey: SESSION_KEY,
          walletAddress: OWNER.address,
          chainId: CALIBRATION_CHAIN_ID,
        })
      )
    ),
  })

  it.each([
    ['in a group beneath a held one', 'team/a/docs'],
    ['in another held group', 'other'],
  ])('shares an upload %s, as a piece grant that opens to its key', async (_case, group) => {
    const labels = labelsFor(newSalt(), group)
    const share = await createShare({
      sender: await groupSender('group:team/a', 'group:other'),
      rootCid: ROOT,
      labels,
      mode: 'open',
      viewer: VIEWER,
    })

    expect(await open(share.link, undefined, labels)).toBe(await ownerPieceKey(labels))
    // The link carries one piece, never a group: the recipient gets this upload only.
    expect(decodeGrant(parseShareLink(share.link).payload).node).toBe(`piece:${labels['foc/salt']}`)
  })

  it('refuses an upload outside every held group, naming the login to run', async () => {
    const labels = labelsFor(newSalt(), 'finance')
    await expect(
      createShare({ sender: await groupSender('group:team/a'), rootCid: ROOT, labels, mode: 'open', viewer: VIEWER })
    ).rejects.toThrow(/in group finance, outside every group .*--group finance/)
  })
})

describe('share links for private uploads', () => {
  const PIECE = 'bafkzcibcgmcfzo4vnay2rysh5udpp4ut7lprug3enpwikqvmnjgnekjjcnrwsjy'
  const OTHER_PIECE = 'bafkzcibcaapao7rtuqyy2qvnpoqbbefwlfb6rnksbmhgqmlnfqxdzfuoxuy5emi'
  const target = {
    cid: PIECE,
    providers: ['https://sp1.test', 'http://localhost:5711'],
    chainId: CALIBRATION_CHAIN_ID,
  }
  const groupSender = async (node: string, maxDepth: number): Promise<ShareSender> => ({
    grants: [
      await openGroupKeyGrant(await makeGrant({ node, maxDepth }), {
        sessionKey: SESSION_KEY,
        walletAddress: OWNER.address,
        chainId: CALIBRATION_CHAIN_ID,
      }),
    ],
    sessionKey: SESSION_KEY,
  })

  /** What a gate checks: the header presented for `pieceCid`, against the piece's labels. */
  const gateAccepts = async (header: string, pieceCid: string, labels: PieceMetadata) =>
    verifyPresentation(new Uint8Array(Buffer.from(header.slice('FOC-Grant '.length), 'base64url')), {
      pieceCid: CID.parse(pieceCid).bytes,
      piece: labels as never,
      chainId: BigInt(CALIBRATION_CHAIN_ID),
    })

  it.each([
    ['the owner wallet', async () => ({ owner: OWNER }) as ShareSender, 1],
    ['a session key, delegating from its group Grant', () => groupSender('group:team', 1), 2],
  ])(
    'from %s: a Delivery that opens the upload and lets the link key fetch that piece only',
    async (_case, sender, links) => {
      const labels = labelsFor(newSalt(), 'team/docs')
      const share = await createShare({
        sender: await sender(),
        rootCid: ROOT,
        labels,
        mode: 'restricted',
        viewer: VIEWER,
        private: target,
      })
      const parsed = parseShareLink(share.link)
      expect(parsed.providers).toEqual(target.providers)
      expect(decodeDelivery(parsed.payload).chain.links).toHaveLength(links)

      const T = shareKey(parsed, share.accessKey)
      expect(await open(share.link, share.accessKey, labels)).toBe(await ownerPieceKey(labels))
      const download = await shareDownload(parsed, T)
      expect(download?.cid).toBe(PIECE)
      const [header] = (await download?.authorizations(PIECE)) ?? []
      expect((await gateAccepts(header ?? '', PIECE, labels)).node).toBe(`piece:${labels['foc/salt']}`)
      await expect(gateAccepts(header ?? '', OTHER_PIECE, labels)).rejects.toThrow(/another piece/)
    }
  )

  it('fetches what the link names: a link located at the root asks for, and signs over, the root', async () => {
    const labels = labelsFor()
    const share = await createShare({
      sender: { owner: OWNER },
      rootCid: ROOT,
      labels,
      mode: 'open',
      viewer: VIEWER,
      private: { ...target, cid: ROOT.toString() },
    })
    const parsed = parseShareLink(share.link)
    const download = await shareDownload(parsed, shareKey(parsed, undefined))
    expect(download?.cid).toBe(ROOT.toString())
    const [header] = (await download?.authorizations(ROOT.toString())) ?? []
    expect((await gateAccepts(header ?? '', ROOT.toString(), labels)).node).toBe(`piece:${labels['foc/salt']}`)
    await expect(gateAccepts(header ?? '', PIECE, labels)).rejects.toThrow(/another piece/)
  })

  it('refuses a session key Grant that allows no delegation, naming the login to run', async () => {
    await expect(
      createShare({
        sender: await groupSender('group:team', 0),
        rootCid: ROOT,
        labels: labelsFor(newSalt(), 'team'),
        mode: 'open',
        viewer: VIEWER,
        private: target,
      })
    ).rejects.toThrow(
      /allows no delegation, so it cannot share a private upload: run `filecoin-pin login --group team`/
    )
  })

  it('refuses a private share once its claim has expired', async () => {
    const labels = labelsFor()
    const share = await createShare({
      sender: { owner: OWNER },
      rootCid: ROOT,
      labels,
      mode: 'open',
      viewer: VIEWER,
      private: target,
    })
    const parsed = parseShareLink(share.link)
    vi.useFakeTimers({ now: Date.now() + 31 * 24 * 3600 * 1000 })
    try {
      await expect(shareDownload(parsed, shareKey(parsed, undefined))).rejects.toThrow(/This share expired at/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a provider in s that is not an http(s) URL', () => {
    const share = `${VIEWER}#v1/${ROOT}&d=gwECAw&s=${encodeURIComponent('javascript:alert(1)')}`
    expect(() => parseShareLink(share)).toThrow(/not an http\(s\) URL/)
  })

  it("a public upload's share has no download: it is fetched on the open path", async () => {
    const share = await createShare({
      sender: { owner: OWNER },
      rootCid: ROOT,
      labels: labelsFor(),
      mode: 'open',
      viewer: VIEWER,
    })
    const parsed = parseShareLink(share.link)
    expect(parsed.providers).toBeUndefined()
    expect(await shareDownload(parsed, shareKey(parsed, undefined))).toBeUndefined()
  })
})
