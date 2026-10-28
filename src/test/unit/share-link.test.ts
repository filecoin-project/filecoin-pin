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
const PIECE = CID.parse('bafkzcibcgmcfzo4vnay2rysh5udpp4ut7lprug3enpwikqvmnjgnekjjcnrwsjy')
const VIEWER = 'https://viewer.test/'
const EXPIRES = Math.floor(Date.now() / 1000) + 30 * 86400

const labelsFor = (salt = newSalt()): PieceMetadata =>
  pieceMetadata({ owner: OWNER.address, keyspace: GROUP_KEY }, { salt })

/** The upload's key as the owner derives it: what every share must open to. */
async function ownerPieceKey(labels: PieceMetadata): Promise<string> {
  const { kk } = await deriveGroupKey(OWNER, { owner: OWNER.address, keyspace: GROUP_KEY })
  return bytesToHex(keyForEnvelope(kk, labels))
}

async function sessionSender(maxDepth = 0): Promise<ShareSender> {
  const text = await makeGrant({ maxDepth })
  const grant = await openGroupKeyGrant(text, {
    sessionKey: SESSION_KEY,
    walletAddress: OWNER.address,
    chainId: CALIBRATION_CHAIN_ID,
  })
  return { sessionKey: SESSION_KEY, grant }
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
  it('owner mode: a delivery the link and Access key open, and nothing else does', async () => {
    const labels = labelsFor()
    const share = await createShare({
      sender: { owner: OWNER },
      rootCid: ROOT,
      labels,
      pieceCid: PIECE,
      chainId: CALIBRATION_CHAIN_ID,
      mode: 'access-key',
      expires: EXPIRES,
      viewer: VIEWER,
    })
    expect(share.payloadKind).toBe('delivery')
    expect(share.expires).toBe(EXPIRES)
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
      chainId: CALIBRATION_CHAIN_ID,
      mode: 'password',
      expires: EXPIRES,
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
        chainId: CALIBRATION_CHAIN_ID,
        mode: 'password',
        password: 'too short',
        expires: EXPIRES,
      })
    ).rejects.toThrow(/at least 12 characters/)
  })

  it('restricted mode: the link opens on its own', async () => {
    const labels = labelsFor()
    const share = await createShare({
      sender: { owner: OWNER },
      rootCid: ROOT,
      labels,
      chainId: CALIBRATION_CHAIN_ID,
      mode: 'restricted',
      expires: EXPIRES,
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
        chainId: CALIBRATION_CHAIN_ID,
        mode: 'access-key',
        expires: EXPIRES,
      })
    ).rejects.toThrow(/belongs to 0x0000000000000000000000000000000000000001/)
  })

  it('a session key whose Grant cannot be re-shared sends a plain grant, which still decrypts', async () => {
    const labels = labelsFor()
    const share = await createShare({
      sender: await sessionSender(0),
      rootCid: ROOT,
      labels,
      chainId: CALIBRATION_CHAIN_ID,
      mode: 'access-key',
      expires: EXPIRES,
      viewer: VIEWER,
    })
    expect(share.payloadKind).toBe('grant')
    expect(share.expires).toBeUndefined()
    expect(await open(share.link, { accessKey: share.accessKey }, labels)).toBe(await ownerPieceKey(labels))
  })

  it('a session key whose Grant allows re-sharing delegates a delivery that lasts as long as the Grant', async () => {
    const labels = labelsFor()
    const sender = await sessionSender(1)
    const share = await createShare({
      sender,
      rootCid: ROOT,
      labels,
      pieceCid: PIECE,
      chainId: CALIBRATION_CHAIN_ID,
      mode: 'access-key',
      expires: EXPIRES,
      viewer: VIEWER,
    })
    expect(share.payloadKind).toBe('delivery')
    expect('grant' in sender && share.expires).toBe('grant' in sender ? sender.grant.chain.expires : undefined)
    expect(await open(share.link, { accessKey: share.accessKey }, labels)).toBe(await ownerPieceKey(labels))
    // A stranger's share key cannot stand in for the Access key.
    await expect(open(share.link, { accessKey: accessKeyText(STRANGER_KEY) }, labels)).rejects.toThrow(
      /does not open this share/
    )
  })
})
