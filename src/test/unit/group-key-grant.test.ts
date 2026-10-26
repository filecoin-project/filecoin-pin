import { decodeDelivery, encodeDelivery, publicKeyOf } from '@filoz/keysmith'
import { recoverMessageAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import {
  GRANT_PREFIX,
  GrantError,
  grantKeyResolver,
  grantText,
  keyAgreementParams,
  loadGroupKeyGrant,
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

/**
 * A Grant made once with makeGrant() (Anvil #0 owner, Anvil #2 session key, calibration,
 * the owner's default group key, expiring 2100-01-01). It must keep decoding: consoles and
 * CLIs of other versions exchange this text form.
 */
const GOLDEN_GRANT =
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
      commitment: 'v1.6a0c83d28d607a8e88dc6791fb49d7e2',
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
    expect((error as GrantError).incomplete).toBe(true)
  })

  it('says text with characters outside base64url is not a Grant, and not that it is incomplete', async () => {
    const error = await openGroupKeyGrant(`${GOLDEN_GRANT.slice(0, 50)}*${GOLDEN_GRANT.slice(51)}`, expected).catch(
      (e: unknown) => e
    )

    expect((error as GrantError).message).toBe(
      'This is not a Grant: it contains characters a Grant never has. Copy it again from the console.'
    )
    expect((error as GrantError).incomplete).toBe(false)
  })

  it('takes a bare prefix as an incomplete paste', async () => {
    const error = await openGroupKeyGrant(GRANT_PREFIX, expected).catch((e: unknown) => e)

    expect((error as GrantError).incomplete).toBe(true)
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

  it('refuses a Grant for less than a whole group key', async () => {
    await rejects(makeGrant({ node: 'scope:team' }), /covers scope:team, not a whole group key/)
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

describe('loadGroupKeyGrant', () => {
  const session = { sessionKey: SESSION_KEY, walletAddress: OWNER.address }

  it('opens GROUP_KEY_GRANT checked against GROUP_KEY_ID', async () => {
    const env = { GROUP_KEY_GRANT: GOLDEN_GRANT, GROUP_KEY_ID: GROUP_KEY }

    expect((await loadGroupKeyGrant(session, CALIBRATION_CHAIN_ID, env)).groupKeyId).toBe(GROUP_KEY)
  })

  it('says there is no Grant, with the login to run', async () => {
    await expect(loadGroupKeyGrant(session, CALIBRATION_CHAIN_ID, {})).rejects.toThrow(
      /no group key Grant\. Run `filecoin-pin login --scopes createDataSet,addPieces,encrypt`/
    )
  })

  it('needs GROUP_KEY_ID with the Grant', async () => {
    await expect(loadGroupKeyGrant(session, CALIBRATION_CHAIN_ID, { GROUP_KEY_GRANT: GOLDEN_GRANT })).rejects.toThrow(
      /GROUP_KEY_GRANT is set without GROUP_KEY_ID/
    )
  })

  it('ignores a Grant that fails a check, with the reason and the login to run', async () => {
    const env = { GROUP_KEY_GRANT: GOLDEN_GRANT, GROUP_KEY_ID: GROUP_KEY }

    await expect(loadGroupKeyGrant(session, 314, env)).rejects.toThrow(
      /The Grant from the environment was ignored: .*another network.* Run `filecoin-pin login --scopes createDataSet,addPieces,encrypt`/
    )
  })
})

describe('grantKeyResolver', () => {
  const opened = () => openGroupKeyGrant(GOLDEN_GRANT, { ...expected, now: PINNED_NOW })
  const labels = (overrides: Record<string, unknown> = {}) => ({
    appMetadata: {
      'foc/v': 1,
      'foc/own': OWNER.address.toLowerCase(),
      'foc/ks': GROUP_KEY,
      'foc/salt': `0x${'01'.repeat(16)}`,
      ...overrides,
    },
  })

  it('derives the piece key for an envelope of its owner and group key', async () => {
    expect(await grantKeyResolver(opened)(labels() as never)).toHaveLength(32)
  })

  it('names the envelope and the Grant for another group key', async () => {
    const other = `0x${'ab'.repeat(16)}`
    await expect(grantKeyResolver(opened)(labels({ 'foc/ks': other }) as never)).rejects.toThrow(
      new RegExp(`belongs to .* under group key ${other}; this session's Grant is for group key ${GROUP_KEY}`)
    )
  })

  it('names the envelope and the Grant for another owner', async () => {
    const stranger = privateKeyToAccount(STRANGER_KEY).address.toLowerCase()
    await expect(grantKeyResolver(opened)(labels({ 'foc/own': stranger }) as never)).rejects.toThrow(
      new RegExp(`belongs to ${stranger} under group key ${GROUP_KEY}; this session's Grant`)
    )
  })

  it('opens the Grant only when an envelope asks for a key, and zeroes the group key after', async () => {
    const loaded: OpenedGrant[] = []
    const resolver = grantKeyResolver(async (): Promise<OpenedGrant> => {
      const grant = await opened()
      loaded.push(grant)
      return grant
    })
    expect(loaded).toHaveLength(0)

    const pieceKey = await resolver(labels() as never)

    expect(loaded).toHaveLength(1)
    expect(pieceKey.some((byte) => byte !== 0)).toBe(true)
    expect(loaded[0]?.key.every((byte) => byte === 0)).toBe(true)
  })

  it('names the source of a Grant that fails to load', async () => {
    const env = { GROUP_KEY_GRANT: GOLDEN_GRANT, GROUP_KEY_ID: GROUP_KEY }
    const session = { sessionKey: SESSION_KEY, walletAddress: OWNER.address }

    await expect(loadGroupKeyGrant(session, 314, env, 'the saved login')).rejects.toThrow(
      /The Grant from the saved login was ignored/
    )
  })
})
