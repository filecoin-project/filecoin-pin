/**
 * `add --encrypt` with the real packer and envelope: only the chain, payments and the
 * upload itself are mocked. Covers what must never reach output or logs, and that the
 * temp directory is left empty however the run ends.
 */

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeGrant, keyspaceKeys as deriveGroupKey, keyForEnvelope, pieceMetadata } from '@filoz/keysmith'
import * as dagPb from '@ipld/dag-pb'
import { bytesToHex, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAdd } from '../../add/add.js'
import { parseShareLink, shareKey, shareKeyResolver } from '../../common/share-link.js'
import { planCarPayload } from '../../common/unixfs-car-payload.js'

const OWNER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

vi.mock('../../core/data-set/list-data-sets.js', () => ({ listDataSets: vi.fn(async () => []) }))

vi.mock('../../core/synapse/index.js', () => ({
  getClientAddress: vi.fn(() => privateKeyToAccount(OWNER_KEY).address),
  isSessionKeyMode: vi.fn(() => false),
  initializeSynapse: vi.fn(async () => ({
    chain: { name: 'calibration', id: 314159 },
    client: { account: privateKeyToAccount(OWNER_KEY) },
    storage: {},
  })),
}))

vi.mock('../../common/upload-flow.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/upload-flow.js')>()
  return {
    ...actual,
    validatePaymentSetup: vi.fn(),
    performAutoFunding: vi.fn(),
    resolveUploadTargets: vi.fn(async () => ({})),
    estimateUploadCost: vi.fn(async () => ({
      requestedCopies: 2,
      newDataSetCount: 2,
      costs: {
        rates: { perEpoch: 1n, perMonth: 1n },
        fees: { total: 0n },
        lockups: { total: 0n },
        depositNeeded: 0n,
        needsFwssMaxApproval: false,
        ready: true,
      },
    })),
    performUpload: vi.fn(async () => ({
      pieceCid: 'bafkzcibpiece',
      size: 1,
      copies: [
        {
          providerId: 1n,
          dataSetId: 1n,
          pieceId: 1n,
          role: 'primary',
          retrievalUrl: 'https://sp.test/piece/bafkzcibpiece',
          isNewDataSet: true,
        },
      ],
      failedAttempts: [],
      network: 'calibration',
    })),
    displayUploadResults: vi.fn(actual.displayUploadResults),
  }
})

vi.mock('../../utils/cli-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/cli-helpers.js')>()),
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  createSpinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn(), clear: vi.fn() })),
}))

const auth = { privateKey: OWNER_KEY, rpcUrl: 'wss://test.rpc.url' }

describe('add --encrypt with real packing', () => {
  let root: string
  let tmp: string
  let input: string
  let writes: string[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'filecoin-pin-add-real-'))
    tmp = join(root, 'tmp')
    input = join(root, 'secret-project')
    await mkdir(tmp)
    await mkdir(join(input, 'nested'), { recursive: true })
    await writeFile(join(input, 'private-name.txt'), 'hello')
    await writeFile(join(input, 'nested', 'other-private.bin'), randomBytes(2048))
    // os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows.
    for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, tmp)

    writes = []
    const capture = (chunk: unknown) => writes.push(String(chunk)) > 0
    vi.spyOn(process.stdout, 'write').mockImplementation(capture)
    vi.spyOn(process.stderr, 'write').mockImplementation(capture)
    // pino writes straight to the fd through sonic-boom, so capture fd 1 and 2 at the fs layer too.
    for (const name of ['write', 'writeSync', 'writev', 'writevSync'] as const) {
      const original = fs[name] as (...args: unknown[]) => unknown
      vi.spyOn(fs, name).mockImplementation(((...args: unknown[]) => {
        if (args[0] !== 1 && args[0] !== 2) return original(...args)
        const data = args[1]
        writes.push(Array.isArray(data) ? data.map(String).join('') : String(data))
        const cb = args.at(-1)
        if (typeof cb === 'function') cb(null, 0)
        return 0
      }) as never)
    }
    vi.stubEnv('LOG_LEVEL', 'debug')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  /** Everything the run printed, logged or showed in a spinner. */
  async function output(): Promise<string> {
    // sonic-boom flushes asynchronously
    await new Promise((resolve) => setTimeout(resolve, 100))
    const { createSpinner } = await import('../../utils/cli-helpers.js')
    const spinners = vi.mocked(createSpinner).mock.results.map((r) => r.value)
    return JSON.stringify([writes, spinners.map((s) => [s.start.mock.calls, s.stop.mock.calls, s.message.mock.calls])])
  }

  /** The plaintext CIDs (wrapper, entries, leaves) the envelope hides. */
  async function plaintextCids(): Promise<string[]> {
    const plan = await planCarPayload(input)
    const cids = [plan.root.toString(), ...plan.layout.leaves.map((leaf) => leaf.cid.toString())]
    for (const node of plan.nodes.values()) {
      cids.push(node.cid.toString(), ...dagPb.decode(node.bytes).Links.map((link) => link.Hash.toString()))
    }
    return cids
  }

  it('prints and logs nothing that names the plaintext: path, names, plaintext CIDs or the key', async () => {
    await runAdd({ ...auth, filePath: input, encrypt: true })

    const out = await output()
    expect(out).toContain('encrypted.fee')
    for (const secret of [input, 'secret-project', 'private-name', 'other-private', OWNER_KEY.slice(2)]) {
      expect(out).not.toContain(secret)
    }
    for (const cid of await plaintextCids()) expect(out).not.toContain(cid)

    const { displayUploadResults } = await import('../../common/upload-flow.js')
    expect(vi.mocked(displayUploadResults).mock.calls[0]?.[0]).toMatchObject({
      filePath: 'encrypted.fee (the real name stays inside the ciphertext)',
    })
  })

  it('shows the public label when --metadata name= sets one', async () => {
    await runAdd({ ...auth, filePath: input, encrypt: true, pieceMetadata: { name: 'q3-report' } })

    const { displayUploadResults } = await import('../../common/upload-flow.js')
    expect(vi.mocked(displayUploadResults).mock.calls.at(-1)?.[0]).toMatchObject({
      filePath: 'q3-report (the real name stays inside the ciphertext)',
    })
  })

  it.skipIf(process.platform === 'win32')(
    'names a bad entry only by position in the spinner, the error and the logs',
    async () => {
      await writeFile(join(input, 'nested', 'private\\name.txt'), 'x')

      const error = await runAdd({ ...auth, filePath: input, encrypt: true }).catch((e: Error) => e)

      expect((error as Error).message).toMatch(/^Entry #\d+ has a name containing "\\"/)
      const out = await output()
      expect(out).toContain('Add failed: Entry #')
      for (const secret of [input, 'secret-project', 'private', 'nested']) expect(out).not.toContain(secret)
    }
  )

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports an unreadable file by position and code only',
    async () => {
      await chmod(join(input, 'private-name.txt'), 0)

      const error = await runAdd({ ...auth, filePath: input, encrypt: true }).catch((e: Error) => e)

      expect((error as Error).message).toMatch(/^Cannot read an input entry \(entry #\d+\): EACCES$/)
      const out = await output()
      for (const secret of [input, 'secret-project', 'private-name']) expect(out).not.toContain(secret)
    }
  )

  describe('leaves the temp directory empty', () => {
    it('after a successful upload', async () => {
      await runAdd({ ...auth, filePath: input, encrypt: true })
      expect(await readdir(tmp)).toEqual([])
    })

    it('after a dry run', async () => {
      await runAdd({ ...auth, filePath: input, encrypt: true, dryRun: true })
      expect(await readdir(tmp)).toEqual([])
    })

    it('after a failed upload', async () => {
      const { performUpload } = await import('../../common/upload-flow.js')
      vi.mocked(performUpload).mockRejectedValueOnce(new Error('provider down'))

      await expect(runAdd({ ...auth, filePath: input, encrypt: true })).rejects.toThrow('provider down')
      expect(await readdir(tmp)).toEqual([])
    })

    it('after Ctrl-C during the upload', async () => {
      vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
      const { performUpload } = await import('../../common/upload-flow.js')
      let leftBySignal: string[] | undefined
      vi.mocked(performUpload).mockImplementationOnce(async () => {
        process.emit('SIGINT')
        leftBySignal = await readdir(tmp)
        throw new Error('interrupted')
      })

      await expect(runAdd({ ...auth, filePath: input, encrypt: true })).rejects.toThrow('interrupted')
      expect(leftBySignal).toEqual([])
      expect(await readdir(tmp)).toEqual([])
    })
  })

  describe('--get-share-link', () => {
    const PIECE = 'bafkzcibcgmcfzo4vnay2rysh5udpp4ut7lprug3enpwikqvmnjgnekjjcnrwsjy'

    it("restricted: prints a link and Access key that open the new upload's key", async () => {
      const { performUpload } = await import('../../common/upload-flow.js')
      let car = Buffer.alloc(0)
      vi.mocked(performUpload).mockImplementationOnce((async (_synapse: unknown, data: ReadableStream<Uint8Array>) => {
        car = Buffer.from(await new Response(data).arrayBuffer())
        return { pieceCid: PIECE, size: 1, copies: [], failedAttempts: [], network: 'calibration' }
      }) as never)
      // Vitest takes console.log over, so the printed link is caught here rather than in `writes`.
      const printed: string[] = []
      vi.spyOn(console, 'log').mockImplementation((line: string) => printed.push(line))

      await runAdd({ ...auth, filePath: input, encrypt: true, getShareLinkRestricted: true })

      const out = printed.join('\n')
      const parsed = parseShareLink(out.match(/https:\/\/\S+#v1\/\S+/)?.[0] ?? '')
      expect(out).toContain('Send the link and the Access key by different channels')
      expect(parsed.accessKey).toBeUndefined()
      // The share names the upload's salt, which must be the one in the uploaded envelope's header.
      const { owner: ownerAddress, keyspace, node } = decodeGrant(parsed.payload)
      const salt = node.replace(/^piece:/, '') as Hex
      expect(car.includes(Buffer.from(salt.slice(2), 'hex')) || car.includes(salt)).toBe(true)
      const labels = pieceMetadata({ owner: ownerAddress, keyspace }, { salt })
      const accessKey = out.match(/fak1_[A-Za-z0-9_-]+/)?.[0]
      const key = await shareKeyResolver(parsed, shareKey(parsed, accessKey))({ appMetadata: labels } as never)
      const owner = privateKeyToAccount(OWNER_KEY)
      const { kk } = await deriveGroupKey(owner, { owner: owner.address, keyspace: labels['foc/ks'] })
      expect(bytesToHex(key)).toBe(bytesToHex(keyForEnvelope(kk, labels)))
    })

    it.each([
      [{ getShareLink: true }, /needs --encrypt/],
      [{ encrypt: true, getShareLink: true, getShareLinkRestricted: true }, /not both/],
      [{ encrypt: true, ipfs: false, getShareLink: true }, /--no-ipfs upload cannot be shared/],
    ])('refuses %o before uploading', async (flags, message) => {
      const { performUpload } = await import('../../common/upload-flow.js')
      await expect(runAdd({ ...auth, filePath: input, ...flags })).rejects.toThrow(message)
      expect(performUpload).not.toHaveBeenCalled()
    })
  })
})
