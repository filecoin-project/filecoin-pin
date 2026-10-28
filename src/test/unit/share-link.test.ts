import { readFileSync } from 'node:fs'
import {
  keyspaceKeys as deriveGroupKey,
  keyForEnvelope,
  newSalt,
  type PieceMetadata,
  pieceMetadata,
} from '@filoz/keysmith'
import { CID } from 'multiformats/cid'
import { bytesToHex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { openGroupKeyGrant } from '../../common/group-key-grant.js'
import {
  accessKeyText,
  createShare,
  formatShareLink,
  parseAccessKey,
  parseShareLink,
  type ShareSender,
  shareKey,
  shareKeyResolver,
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

const labelsFor = (salt = newSalt()): PieceMetadata =>
  pieceMetadata({ owner: OWNER.address, keyspace: GROUP_KEY }, { salt })

/** The upload's key as the owner derives it: what every share must open to. */
async function ownerPieceKey(labels: PieceMetadata): Promise<string> {
  const { kk } = await deriveGroupKey(OWNER, { owner: OWNER.address, keyspace: GROUP_KEY })
  return bytesToHex(keyForEnvelope(kk, labels))
}

async function sessionSender(): Promise<ShareSender> {
  const text = await makeGrant()
  const grant = await openGroupKeyGrant(text, {
    sessionKey: SESSION_KEY,
    walletAddress: OWNER.address,
    chainId: CALIBRATION_CHAIN_ID,
  })
  return { grant }
}

/** Open a created share as a recipient would, and return the key it gives for `labels`. */
async function open(
  link: string,
  given: { accessKey?: string | undefined; password?: string | undefined },
  labels: PieceMetadata
) {
  const parsed = parseShareLink(link)
  const key = await shareKeyResolver(parsed, await shareKey(parsed, given))({ appMetadata: labels } as never)
  return bytesToHex(key)
}

describe('share link text', () => {
  it('round-trips each mode, and ignores a fragment already on the viewer URL', () => {
    const payload = new Uint8Array([0x83, 1, 2, 3])
    const key = generatePrivateKey()
    const salt = new Uint8Array(16).fill(7)
    for (const secret of [undefined, { kind: 'access-key' as const, key }, { kind: 'password' as const, salt }]) {
      const link = formatShareLink(`${VIEWER}#old`, ROOT, payload, secret)
      expect(link.startsWith(`${VIEWER}#v1/${ROOT}&d=`)).toBe(true)
      const parsed = parseShareLink(link)
      expect(parsed.rootCid.equals(ROOT)).toBe(true)
      expect(parsed.payload).toEqual(payload)
      expect(parsed.secret).toEqual(secret)
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
    expect(() => parseShareLink(`${link}&p=pw2.AAAA`)).toThrow(/unknown password scheme/)
  })
})

describe('createShare', () => {
  it('owner mode: a link the Access key opens, and nothing else does', async () => {
    const labels = labelsFor()
    const share = await createShare({
      sender: { owner: OWNER },
      rootCid: ROOT,
      labels,
      mode: 'access-key',
      viewer: VIEWER,
    })
    expect(share.link).not.toContain('&k=')
    expect(await open(share.link, { accessKey: share.accessKey }, labels)).toBe(await ownerPieceKey(labels))
    // The link alone, or another key, opens nothing.
    await expect(open(share.link, {}, labels)).rejects.toThrow(/needs its Access key/)
    await expect(open(share.link, { accessKey: accessKeyText(generatePrivateKey()) }, labels)).rejects.toThrow(
      /does not open this share/
    )
    // One upload only: another piece of the same group key is refused.
    await expect(open(share.link, { accessKey: share.accessKey }, labelsFor())).rejects.toThrow(/another upload/)
  })

  it('password mode: generates a password, and opens only with it', async () => {
    const labels = labelsFor()
    const share = await createShare({
      sender: { owner: OWNER },
      rootCid: ROOT,
      labels,
      mode: 'password',
      viewer: VIEWER,
    })
    expect(share.accessKey).toBeUndefined()
    expect(share.password).toMatch(/^[a-z2-7]{5}(-[a-z2-7]{5}){3}$/)
    expect(share.link).toContain('&p=pw1.')
    expect(await open(share.link, { password: share.password }, labels)).toBe(await ownerPieceKey(labels))
    await expect(open(share.link, { password: `${share.password}x` }, labels)).rejects.toThrow(
      /does not open this share/
    )
    await expect(
      createShare({
        sender: { owner: OWNER },
        rootCid: ROOT,
        labels,
        mode: 'password',
        password: 'too short',
      })
    ).rejects.toThrow(/at least 12 characters/)
  })

  it('restricted mode: the link opens on its own', async () => {
    const labels = labelsFor()
    const share = await createShare({
      sender: { owner: OWNER },
      rootCid: ROOT,
      labels,
      mode: 'restricted',
      viewer: VIEWER,
    })
    expect(share.accessKey).toBeUndefined()
    expect(share.link).toContain('&k=fak1_')
    expect(await open(share.link, {}, labels)).toBe(await ownerPieceKey(labels))
  })

  it('refuses to share an upload of another owner', async () => {
    const labels = pieceMetadata(
      { owner: '0x0000000000000000000000000000000000000001', keyspace: GROUP_KEY },
      { salt: newSalt() }
    )
    await expect(
      createShare({
        sender: { owner: OWNER },
        rootCid: ROOT,
        labels,
        mode: 'access-key',
      })
    ).rejects.toThrow(/belongs to 0x0000000000000000000000000000000000000001/)
  })

  it("a session key shares with its Grant's group key", async () => {
    const labels = labelsFor()
    const share = await createShare({
      sender: await sessionSender(),
      rootCid: ROOT,
      labels,
      mode: 'access-key',
      viewer: VIEWER,
    })
    expect(await open(share.link, { accessKey: share.accessKey }, labels)).toBe(await ownerPieceKey(labels))
    // A stranger's share key cannot stand in for the Access key.
    await expect(open(share.link, { accessKey: accessKeyText(STRANGER_KEY) }, labels)).rejects.toThrow(
      /does not open this share/
    )
  })
})

interface OpeningVector {
  name: string
  link: string
  accessKey?: string
  password?: string
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
  const SALT = Uint8Array.from({ length: 16 }, (_, i) => i)
  const FRAGMENT = `${VIEWER}#v1/${ROOT}&d=gwECAw`

  it.each([
    ['access key', undefined, FRAGMENT],
    [
      'restricted',
      { kind: 'access-key' as const, key: KEY },
      `${FRAGMENT}&k=fak1_AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA`,
    ],
    ['password', { kind: 'password' as const, salt: SALT }, `${FRAGMENT}&p=pw1.AAECAwQFBgcICQoLDA0ODw`],
  ])('formats and parses the %s link form exactly', (_, secret, link) => {
    expect(formatShareLink(VIEWER, ROOT, PAYLOAD, secret)).toBe(link)
    expect(parseShareLink(link)).toEqual({ rootCid: ROOT, payload: PAYLOAD, ...(secret != null && { secret }) })
  })

  // Made once on 2026-10-28 by createShare (owner: Anvil #0; GROUP_KEY; salt 00..0f; bearers
  // random). Links already sent must keep opening: a change to the link, the grant or pw1 must
  // show up here, not get regenerated.
  it('derives the pinned piece key from the vector labels', async () => {
    expect(await ownerPieceKey(vectors.labels)).toBe(vectors.pieceKey)
  })

  it.each(vectors.opening)('opens "$name" to the pinned piece key', async (vector) => {
    const parsed = parseShareLink(vector.link)
    expect(parsed.rootCid.equals(ROOT)).toBe(true)
    const T = await shareKey(parsed, vector)
    const key = await shareKeyResolver(parsed, T)({ appMetadata: vectors.labels } as never)
    expect(bytesToHex(key)).toBe(vectors.pieceKey)
  }, 30_000)
})
