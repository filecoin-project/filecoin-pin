import { deriveGroupKey, keyForEnvelope, newSalt, pieceMetadata } from '@filoz/keysmith'
import { bytesToHex } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseShareLink, shareKey, shareKeyResolver } from '../../common/share-link.js'
import { runGetShareLink } from '../../share/get-share-link.js'
import { GROUP_KEY, OWNER, OWNER_KEY } from '../fixtures/group-key-grants.js'

const header = vi.hoisted(() => ({ labels: undefined as unknown }))
// None of the sharer's private uploads is rooted at ROOT, so the link is for a public one
const findPrivatePiece = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined))
vi.mock('../../common/envelope-labels.js', () => ({ readEnvelopeLabels: async () => header.labels }))
vi.mock('../../common/ipfs-car-fetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../common/ipfs-car-fetch.js')>()),
  ipniProviderUrls: async () => [],
  findPrivatePiece,
}))
vi.mock('../../get/get.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../get/get.js')>()),
  ownProviders: async () => [],
  readOnlySynapse: async () => ({}),
}))
vi.mock('../../utils/cli-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/cli-helpers.js')>()),
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  createSpinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn(), clear: vi.fn() })),
}))

const ROOT = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

describe('runGetShareLink', () => {
  afterEach(() => {
    header.labels = undefined
    vi.restoreAllMocks()
  })

  it.each([
    ['an open link', {}],
    ['a restricted link and its Access key', { restricted: true }],
  ])('prints %s that opens the upload whose header was read', async (_, mode) => {
    const labels = pieceMetadata({ owner: OWNER.address, groupKeyId: GROUP_KEY }, { salt: newSalt() })
    header.labels = labels
    const printed: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => printed.push(line))

    await runGetShareLink(ROOT, {
      privateKey: OWNER_KEY,
      network: 'calibration',
      viewer: 'https://viewer.test/',
      ...mode,
    })

    // It looked among the sharer's private uploads first
    expect(String(findPrivatePiece.mock.calls[0]?.[1])).toBe(ROOT)
    const text = printed.join('\n')
    const parsed = parseShareLink(text.match(/https:\/\/viewer\.test\/#\S+/)?.[0] ?? '')
    expect(parsed.rootCid.toString()).toBe(ROOT)
    // Only a restricted link leaves its key out, printed on a line of its own.
    const accessKey = text.match(/^fak1_\S+/m)?.[0]
    expect(parsed.accessKey == null).toBe(accessKey != null)
    expect(accessKey != null).toBe('restricted' in mode)
    const key = await shareKeyResolver(parsed, shareKey(parsed, accessKey))({ appMetadata: labels } as never)
    const { groupKey: kk } = await deriveGroupKey(OWNER, { owner: OWNER.address, groupKeyId: GROUP_KEY })
    expect(bytesToHex(key)).toBe(bytesToHex(keyForEnvelope(kk, labels)))
  })

  it('refuses view-only credentials', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(
      runGetShareLink(ROOT, { viewAddress: OWNER.address, network: 'calibration' } as never)
    ).rejects.toThrow(/owner wallet/)
  })
})
