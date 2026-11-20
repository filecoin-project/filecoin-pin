import { decodeDelivery, encodeDelivery, publicKeyOf, verifyPresentation } from '@filoz/keysmith'
import { CID } from 'multiformats/cid'
import { recoverMessageAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it, vi } from 'vitest'
import { ownerAuthorizations } from '../../common/group-key.js'
import {
  GRANT_PREFIX,
  GrantError,
  grantAuthorizations,
  grantForPiece,
  grantForWrite,
  grantKeyResolver,
  grantText,
  joinGrants,
  keyAgreementParams,
  loadGroupKeyGrants,
  type OpenedGrant,
  openGroupKeyGrant,
} from '../../common/group-key-grant.js'
import {
  CALIBRATION_CHAIN_ID,
  FAR_FUTURE,
  GROUP_KEY,
  groupKeyCommitment,
  makeGrant,
  OTHER_SESSION_KEY,
  OWNER,
  SESSION_ADDRESS,
  SESSION_KEY,
  STRANGER_KEY,
} from '../fixtures/group-key-grants.js'

// ownerAuthorizations reads the owner's data sets; nothing else here does.
const { mockListDataSets } = vi.hoisted(() => ({ mockListDataSets: vi.fn() }))
vi.mock('../../core/data-set/list-data-sets.js', () => ({ listDataSets: mockListDataSets }))

/**
 * A Grant made once with makeGrant() (Anvil #0 owner, Anvil #2 session key, calibration,
 * the owner's default group key, expiring 2100-01-01). It must keep decoding: consoles and
 * CLIs of other versions exchange this text form.
 */
const GOLDEN_GRANT =
  'fgr1_gwKBqwACAWhncm91cEtleQJU85_W5RqtiPb0zmq4gnJ5z_-5ImYDUALKCM9-AiLIQyrcFZIyt-sEVDxEzd22qQD6K1hd0pngPRL6QpO8BQAGGgAEyy8HUKTAK_v_zb_3Sz5mAaZ0bZwIWEFG8XomGpP0MPKlif23na1MQLEFFhipPX0GNZbtOZtVbEnsqFZxhM0Tq5a53kaP2LBSDM5ZEU3WcH3MOkQtzt5QGwpQpMAr-__Nv_dLPmYBpnRtnAsa9IZXAFi6pwACAWhncm91cEtleQJU85_W5RqtiPb0zmq4gnJ5z_-5ImYDUALKCM9-AiLIQyrcFZIyt-sEWEEEBoUkIEGC2gyP3meS8N2b9UhsyBd3WReZgk7mSKPpS6C32SriAFwr42n4tCRCEkfwYwayZrzr65t4R75nm1wcuAVMtAgEssgVvy1RrhL7Blgw-shWVySbCmDnncKG_XYFLv-tFsqTcdkWlaSISB1gboMHUylMQWkyH0lKC6Lzb0Bn'
/** A Grant made by filecoin-pin 2.4 (keysmith 0.1.0, format 1), which this version refuses as such. */
const V1_GRANT =
  'fgr1_gwGBqwABAWhrZXlzcGFjZQJU85_W5RqtiPb0zmq4gnJ5z_-5ImYDUALKCM9-AiLIQyrcFZIyt-sEVDxEzd22qQD6K1hd0pngPRL6QpO8BQAGGgAEyy8HUGoMg9KNYHqOiNxnkftJ1-IIWEGdCbSL16RMCZ2Hjsznju8VSTRpq-2RHLu7I-Bporb53VomKJ-goC0IRqON69e6bUOcH7QUKmWcKFlpQI2nT5JjGwpQagyD0o1geo6I3GeR-0nX4gsa9IZXAFi6pwABAWhrZXlzcGFjZQJU85_W5RqtiPb0zmq4gnJ5z_-5ImYDUALKCM9-AiLIQyrcFZIyt-sEWEEEQ9-xkEnBkX7FqCJHDgkGNVOlDBknDtAvJ__SuOQjpQlgLGfm1EvV4j3YxrjJg33xI92pA85BM-J4cgycL0Yl1QVMYIy-eUdXcvuV3NhHBlgwikJobsjiFOwzSVnbA7-WyI7_-0AIn8UgnzuANx3YCl_SQDZrM8iUMIDuNL620d39'
/** 2026-01-01, so the golden vector is checked at a fixed time. */
const PINNED_NOW = 1767225600

const expected = { sessionKey: SESSION_KEY, walletAddress: OWNER.address, chainId: CALIBRATION_CHAIN_ID }

describe('openGroupKeyGrant', () => {
  it('opens the golden vector', async () => {
    const opened = await openGroupKeyGrant(GOLDEN_GRANT, { ...expected, groupKeyId: GROUP_KEY, now: PINNED_NOW })

    expect(opened).toMatchObject({
      text: GOLDEN_GRANT,
      groupKeyId: GROUP_KEY,
      owner: OWNER.address,
      expires: FAR_FUTURE,
      commitment: 'v2.a4c02bfbffcdbff74b3e6601a6746d9c',
    })
    // The commitment the owner signed is the one owner-mode uploads record as foc/kc.
    expect(opened.commitment).toBe(await groupKeyCommitment())
    expect(opened.key).toHaveLength(32)
  })

  it('strips every whitespace character, so a wrapped paste opens', async () => {
    const wrapped = `  ${GOLDEN_GRANT.slice(0, 100)}\n${GOLDEN_GRANT.slice(100, 300)}\r\n\t${GOLDEN_GRANT.slice(300)} \n`

    const opened = await openGroupKeyGrant(wrapped, { ...expected, now: PINNED_NOW })

    expect(opened.text).toBe(GOLDEN_GRANT)
  })

  it('writes the delivery as fgr1_ and unpadded base64url', () => {
    expect(grantText(new Uint8Array([0xfb, 0xff]))).toBe(`${GRANT_PREFIX}-_8`)
  })

  const rejects = (text: string | Promise<string>, message: RegExp, overrides: object = {}) =>
    expect(
      Promise.resolve(text).then((t) => openGroupKeyGrant(t, { ...expected, now: PINNED_NOW, ...overrides }))
    ).rejects.toThrow(message)

  it('says an Access key is not a Grant', async () => {
    await rejects('fak1_c2VjcmV0', /This is an Access key, not a Grant/)
  })

  it('says a share link is not a Grant', async () => {
    await rejects('https://viewer.example/#v1/bafyabc', /This is a share link, not a Grant/)
    await rejects('viewer.example/#v1/bafyabc', /This is a share link/)
  })

  it('refuses any other prefix', async () => {
    await rejects(GOLDEN_GRANT.slice(GRANT_PREFIX.length), /not a Grant: a Grant starts with fgr1_/)
  })

  it('says a truncated Grant is incomplete', async () => {
    const error = await openGroupKeyGrant(GOLDEN_GRANT.slice(0, 200), expected).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(GrantError)
    expect((error as GrantError).message).toMatch(/incomplete or corrupted; copy it again/)
  })

  it('says text with characters outside base64url is not a Grant', async () => {
    const error = await openGroupKeyGrant(`${GOLDEN_GRANT.slice(0, 50)}*${GOLDEN_GRANT.slice(51)}`, expected).catch(
      (e: unknown) => e
    )

    expect((error as GrantError).message).toBe(
      'This is not a Grant: it contains characters a Grant never has. Copy it again from the console.'
    )
  })

  it('refuses padded and standard-alphabet base64: the text form is unpadded base64url', async () => {
    const body = GOLDEN_GRANT.slice(GRANT_PREFIX.length)
    await rejects(`${GOLDEN_GRANT}==`, /characters a Grant never has/)
    await rejects(`${GRANT_PREFIX}${body.replaceAll('-', '+').replaceAll('_', '/')}`, /characters a Grant never has/)
  })

  it('refuses a tampered Grant: the signature no longer verifies', async () => {
    const { chain, grant } = decodeDelivery(new Uint8Array(Buffer.from(GOLDEN_GRANT.slice(5), 'base64url')))
    const tampered = grantText(encodeDelivery({ ...chain, expires: chain.expires - 1 }, grant))

    await rejects(tampered, /does not verify .*copy it again/)
  })

  it('refuses a Grant for another session key, naming both', async () => {
    await rejects(
      GOLDEN_GRANT,
      new RegExp(
        `another session key \\(${SESSION_ADDRESS}\\), not this one \\(${privateKeyToAccount(OTHER_SESSION_KEY).address}\\)`
      ),
      { sessionKey: OTHER_SESSION_KEY }
    )
  })

  it('refuses an expired Grant', async () => {
    await rejects(makeGrant({ expires: PINNED_NOW - 1 }), /expired at 2025-12-31T23:59:59\.000Z/)
    // The golden vector too, once its time has come.
    await rejects(GOLDEN_GRANT, /expired/, { now: FAR_FUTURE })
  })

  it('refuses a Grant from another wallet', async () => {
    const stranger = privateKeyToAccount(STRANGER_KEY).address
    await rejects(GOLDEN_GRANT, new RegExp(`from wallet ${OWNER.address}, not ${stranger}`), {
      walletAddress: stranger,
    })
  })

  it('refuses a Grant for another network', async () => {
    await rejects(GOLDEN_GRANT, /another network \(chain id 314159, not 314\)/, { chainId: 314 })
  })

  it('opens a Grant for a group, not only the whole group key', async () => {
    const opened = await openGroupKeyGrant(await makeGrant({ node: 'group:team' }), expected)
    expect(opened.group).toBe('team')
  })

  it('refuses a Grant for another group key than GROUP_KEY_ID', async () => {
    const other = `0x${'ab'.repeat(16)}`
    await rejects(GOLDEN_GRANT, new RegExp(`group key ${GROUP_KEY}, but GROUP_KEY_ID is ${other}`), {
      groupKeyId: other,
    })
  })
})

describe('keyAgreementParams', () => {
  it("is the session key's Keysmith public key, signed by the session key over the agreed message", async () => {
    const { pubkey, pubkeysig } = await keyAgreementParams(SESSION_KEY)

    expect(pubkey).toBe(publicKeyOf(SESSION_KEY).toLowerCase())
    expect(pubkey).toMatch(/^0x04[0-9a-f]{128}$/)
    expect(pubkeysig).toMatch(/^0x[0-9a-f]{130}$/)
    const signer = await recoverMessageAddress({
      message: `Keysmith key agreement key: ${pubkey}`,
      signature: pubkeysig,
    })
    expect(signer).toBe(SESSION_ADDRESS)
  })
})

describe('loadGroupKeyGrants', () => {
  const session = { sessionKey: SESSION_KEY, walletAddress: OWNER.address }

  it('opens GROUP_KEY_GRANT checked against GROUP_KEY_ID', async () => {
    const env = { GROUP_KEY_GRANT: GOLDEN_GRANT, GROUP_KEY_ID: GROUP_KEY }

    expect((await loadGroupKeyGrants(session, CALIBRATION_CHAIN_ID, env)).map((g) => g.groupKeyId)).toEqual([GROUP_KEY])
  })

  it('says there is no Grant, with the login to run', async () => {
    await expect(loadGroupKeyGrants(session, CALIBRATION_CHAIN_ID, {})).rejects.toThrow(
      /no group key Grant\. Run `filecoin-pin login --scopes createDataSet,addPieces,encrypt`/
    )
  })

  it('needs GROUP_KEY_ID with the Grant', async () => {
    await expect(loadGroupKeyGrants(session, CALIBRATION_CHAIN_ID, { GROUP_KEY_GRANT: GOLDEN_GRANT })).rejects.toThrow(
      /GROUP_KEY_GRANT is set without GROUP_KEY_ID/
    )
  })

  it('ignores a Grant that fails a check, with the reason and the login to run', async () => {
    const env = { GROUP_KEY_GRANT: GOLDEN_GRANT, GROUP_KEY_ID: GROUP_KEY }

    await expect(loadGroupKeyGrants(session, 314, env)).rejects.toThrow(
      /The Grant in GROUP_KEY_GRANT was ignored: .*another network.* Run `filecoin-pin login --scopes createDataSet,addPieces,encrypt`/
    )
  })

  it('skips a Grant that no longer opens with a warning, and keeps the others', async () => {
    const expired = await makeGrant({ node: 'group:old', expires: Math.floor(Date.now() / 1000) - 60 })
    const env = {
      GROUP_KEY_GRANT: joinGrants([expired, await makeGrant({ node: 'group:live' })]),
      GROUP_KEY_ID: GROUP_KEY,
    }
    const warnings: string[] = []

    const grants = await loadGroupKeyGrants(session, CALIBRATION_CHAIN_ID, env, (message) => warnings.push(message))

    expect(grants.map((g) => g.group)).toEqual(['live'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/A Grant in GROUP_KEY_GRANT was ignored: This Grant expired at/)
  })

  it('says a keysmith 0.1.0 Grant (filecoin-pin 2.3, 2.4) is no longer readable, not that it is corrupted', async () => {
    const env = { GROUP_KEY_GRANT: V1_GRANT, GROUP_KEY_ID: GROUP_KEY }
    await expect(loadGroupKeyGrants(session, CALIBRATION_CHAIN_ID, env)).rejects.toThrow(
      /keysmith 0\.1\.0 \(format 1\) data is not supported.* Get a new Grant/
    )
  })
})

describe('grantKeyResolver', () => {
  const opened = async () => [await openGroupKeyGrant(GOLDEN_GRANT, { ...expected, now: PINNED_NOW })]
  const labels = (overrides: Record<string, unknown> = {}) => ({
    appMetadata: {
      'foc/v': 2,
      'foc/own': OWNER.address.toLowerCase(),
      'foc/gkid': GROUP_KEY,
      'foc/salt': `0x${'01'.repeat(16)}`,
      ...overrides,
    },
  })

  it('derives the piece key for an envelope of its owner and group key', async () => {
    expect(await grantKeyResolver(opened)(labels() as never)).toHaveLength(32)
  })

  it('names the envelope and the Grant for another group key', async () => {
    const other = `0x${'ab'.repeat(16)}`
    await expect(grantKeyResolver(opened)(labels({ 'foc/gkid': other }) as never)).rejects.toThrow(
      new RegExp(`belongs to .* under group key ${other}; this session's Grants are for group key ${GROUP_KEY}`)
    )
  })

  it('names the envelope and the Grant for another owner', async () => {
    const stranger = privateKeyToAccount(STRANGER_KEY).address.toLowerCase()
    await expect(grantKeyResolver(opened)(labels({ 'foc/own': stranger }) as never)).rejects.toThrow(
      new RegExp(`belongs to ${stranger} under group key ${GROUP_KEY}; this session's Grants`)
    )
  })

  it('opens the Grant only when an envelope asks for a key, and zeroes the group key after', async () => {
    const loaded: OpenedGrant[] = []
    const resolver = grantKeyResolver(async (): Promise<OpenedGrant[]> => {
      const grants = await opened()
      loaded.push(...grants)
      return grants
    })
    expect(loaded).toHaveLength(0)

    const pieceKey = await resolver(labels() as never)

    expect(loaded).toHaveLength(1)
    expect(pieceKey.some((byte) => byte !== 0)).toBe(true)
    expect(loaded[0]?.key.every((byte) => byte === 0)).toBe(true)
  })
})

describe('group Grants', () => {
  const session = { sessionKey: SESSION_KEY, walletAddress: OWNER.address }
  const openAll = async (...nodes: string[]) =>
    loadGroupKeyGrants(session, CALIBRATION_CHAIN_ID, {
      GROUP_KEY_GRANT: joinGrants(await Promise.all(nodes.map((node) => makeGrant({ node })))),
      GROUP_KEY_ID: GROUP_KEY,
    })
  const piece = (group?: string) => ({
    'foc/v': 2,
    'foc/own': OWNER.address.toLowerCase(),
    'foc/gkid': GROUP_KEY,
    ...(group != null && { 'foc/group': group }),
    'foc/salt': `0x${'01'.repeat(16)}`,
  })

  it('opens a group Grant and names its group', async () => {
    const [grant] = await openAll('group:team/design')
    expect(grant?.group).toBe('team/design')
    expect(grant?.claim.node).toBe('group:team/design')
  })

  it('writes with the narrowest Grant that covers the group, refusing one no Grant covers', async () => {
    const grants = await openAll('group:a', 'group:b/c')
    expect(grantForWrite(grants, 'b/c/d').group).toBe('b/c')
    expect(grantForWrite(grants, 'a').group).toBe('a')
    expect(() => grantForWrite(grants, 'b')).toThrow(/None of this session key's Grants covers group b .*--group b/)
  })

  it('needs --group to write when several group Grants are held, unless one is the whole group key', async () => {
    const disjoint = await openAll('group:a', 'group:b')
    expect(() => grantForWrite(disjoint, undefined)).toThrow(/choose one with --group/)
    expect(grantForWrite(await openAll('group:a', 'groupKey'), undefined).group).toBeUndefined()
    expect(grantForWrite(await openAll('group:a'), undefined).group).toBe('a')
  })

  it('reads a piece with the Grant whose group reaches it, and names the login for one outside every group', async () => {
    const grants = await openAll('group:a', 'group:b')
    expect(grantForPiece(grants, piece('b/x')).group).toBe('b')
    expect(() => grantForPiece(grants, piece('c'))).toThrow(/in group c, outside every group .*--group c/)
    expect(() => grantForPiece(grants, piece())).toThrow(/at the group key root/)
  })

  it('decrypts with either of two disjoint group Grants', async () => {
    const resolver = grantKeyResolver(() => openAll('group:a', 'group:b'))
    expect(await resolver({ appMetadata: piece('a') } as never)).toHaveLength(32)
    expect(await resolver({ appMetadata: piece('b/deep') } as never)).toHaveLength(32)
    await expect(resolver({ appMetadata: piece('c') } as never)).rejects.toThrow(/outside every group/)
  })
})

describe('grantAuthorizations', () => {
  const PIECE = 'bafkzcibcgmcfzo4vnay2rysh5udpp4ut7lprug3enpwikqvmnjgnekjjcnrwsjy'
  const OTHER_PIECE = 'bafkzcibcaapao7rtuqyy2qvnpoqbbefwlfb6rnksbmhgqmlnfqxdzfuoxuy5emi'
  const session = { sessionKey: SESSION_KEY, walletAddress: OWNER.address }
  const piece = (group?: string) => ({
    'foc/v': 2,
    'foc/own': OWNER.address.toLowerCase(),
    'foc/gkid': GROUP_KEY,
    ...(group != null && { 'foc/group': group }),
    'foc/salt': `0x${'01'.repeat(16)}`,
  })
  const check = (header: string, cid: string, group?: string) =>
    verifyPresentation(new Uint8Array(Buffer.from(header.slice('FOC-Grant '.length), 'base64url')), {
      pieceCid: CID.parse(cid).bytes,
      piece: piece(group) as never,
      chainId: BigInt(CALIBRATION_CHAIN_ID),
    })

  it('makes one FOC-Grant header per held Grant, the whole group key first, each for that piece only', async () => {
    const env = {
      GROUP_KEY_GRANT: joinGrants([await makeGrant({ node: 'group:a' }), await makeGrant()]),
      GROUP_KEY_ID: GROUP_KEY,
    }
    vi.stubEnv('GROUP_KEY_GRANT', env.GROUP_KEY_GRANT)
    vi.stubEnv('GROUP_KEY_ID', env.GROUP_KEY_ID)
    try {
      const authorizations = grantAuthorizations(session, CALIBRATION_CHAIN_ID)
      const [whole, groupA] = await authorizations(PIECE)
      expect(whole).toMatch(/^FOC-Grant [A-Za-z0-9_-]+$/)
      // The whole group key's chain reaches a piece in any group; group a's reaches only group a.
      expect((await check(whole as string, PIECE, 'b')).bearer).toBe(SESSION_ADDRESS)
      expect((await check(groupA as string, PIECE, 'a/x')).bearer).toBe(SESSION_ADDRESS)
      await expect(check(groupA as string, PIECE, 'b')).rejects.toThrow(/does not reach/)
      await expect(check(whole as string, OTHER_PIECE)).rejects.toThrow(/names another piece/)

      // The Grants were opened once: a later call (another provider) signs new requests without reading them again.
      vi.stubEnv('GROUP_KEY_GRANT', '')
      const again = await authorizations(PIECE)
      expect(again).toHaveLength(2)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('ownerAuthorizations', () => {
  const PIECE = 'bafkzcibcgmcfzo4vnay2rysh5udpp4ut7lprug3enpwikqvmnjgnekjjcnrwsjy'
  const OTHER = `0x${'ab'.repeat(16)}` as const
  // Every encrypted data set records foc/enc "1" with its group key and commitment
  const dataSet = (id: bigint, metadata: Record<string, string>) => ({
    dataSetId: id,
    isLive: true,
    metadata: { 'foc/enc': '1', ...metadata },
  })
  const synapse = { chain: { id: CALIBRATION_CHAIN_ID } } as never

  it('signs a root claim to itself per group key of its private data sets, once, and a request per call', async () => {
    const kc = { [GROUP_KEY]: await groupKeyCommitment(GROUP_KEY), [OTHER]: await groupKeyCommitment(OTHER) }
    const all = [
      dataSet(1n, { read: 'restricted', 'foc/gkid': GROUP_KEY, 'foc/kc': kc[GROUP_KEY] as string }),
      dataSet(2n, { read: 'restricted', 'foc/gkid': OTHER, 'foc/kc': kc[OTHER] as string }),
      dataSet(3n, { read: 'restricted', 'foc/gkid': GROUP_KEY, 'foc/kc': kc[GROUP_KEY] as string }),
      dataSet(4n, { 'foc/gkid': `0x${'cd'.repeat(16)}` }),
    ]
    mockListDataSets.mockImplementation(async (_s, { filter }) => all.filter(filter))
    const signs = vi.spyOn(OWNER, 'signTypedData')
    const authorizations = ownerAuthorizations(synapse, OWNER)

    const headers = await authorizations(PIECE)
    expect(headers).toHaveLength(2)
    const piece = (groupKeyId: string) => ({
      'foc/v': 2,
      'foc/own': OWNER.address.toLowerCase(),
      'foc/gkid': groupKeyId,
      'foc/salt': `0x${'01'.repeat(16)}`,
    })
    const check = (header: string, groupKeyId: string) =>
      verifyPresentation(new Uint8Array(Buffer.from(header.slice('FOC-Grant '.length), 'base64url')), {
        pieceCid: CID.parse(PIECE).bytes,
        piece: piece(groupKeyId) as never,
        chainId: BigInt(CALIBRATION_CHAIN_ID),
      })
    expect((await check(headers[0] ?? '', GROUP_KEY)).bearer).toBe(OWNER.address)
    expect((await check(headers[1] ?? '', OTHER)).bearer).toBe(OWNER.address)
    await expect(check(headers[0] ?? '', OTHER)).rejects.toThrow()

    // Per group key: its signature and the root claim; then one request each. A second call signs requests only.
    expect(signs).toHaveBeenCalledTimes(6)
    await authorizations(PIECE)
    expect(signs).toHaveBeenCalledTimes(8)
    signs.mockRestore()
  })

  it('skips a group key with a malformed id or a commitment this wallet does not match, and fetches with the rest', async () => {
    const kc = await groupKeyCommitment(GROUP_KEY)
    const all = [
      dataSet(1n, { read: 'restricted', 'foc/gkid': GROUP_KEY, 'foc/kc': kc }),
      dataSet(2n, { read: 'restricted', 'foc/gkid': OTHER.toUpperCase().replace('0X', '0x'), 'foc/kc': kc }),
      dataSet(3n, { read: 'restricted', 'foc/gkid': OTHER, 'foc/kc': kc }),
    ]
    mockListDataSets.mockImplementation(async (_s, { filter }) => all.filter(filter))
    const warn = vi.fn()
    const headers = await ownerAuthorizations(synapse, OWNER, { warn } as never)(PIECE)
    expect(headers).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('says so when none of its group keys can be read', async () => {
    mockListDataSets.mockResolvedValue([dataSet(1n, { read: 'restricted', 'foc/gkid': OTHER, 'foc/kc': 'nope' })])
    await expect(ownerAuthorizations(synapse, OWNER)(PIECE)).rejects.toThrow(/has a group key it can read/)
  })

  it('says so when the wallet has no private data sets', async () => {
    mockListDataSets.mockResolvedValue([])
    await expect(ownerAuthorizations(synapse, OWNER)(PIECE)).rejects.toThrow(/has no private data sets/)
  })
})
