import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { keyspaceKeys as deriveGroupKey, writeTarget } from '@filoz/keysmith'
import { CarIndexedReader, CarWriter } from '@ipld/car'
import * as dagPb from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'
import { CID } from 'multiformats/cid'
import * as Digest from 'multiformats/hashes/digest'
import { sha256 } from 'multiformats/hashes/sha2'
import { pino } from 'pino'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliIncomplete, EXIT_CODE_INCOMPLETE } from '../../common/cli-errors.js'
import { decryptToDirectory, encryptPath } from '../../common/encryption.js'
import { newPieceKey, ownerKeyResolver, type PieceKey } from '../../common/group-key.js'
import { FETCH_CONCURRENCY, NoProviderError, NotUnixfsError } from '../../common/ipfs-car-fetch.js'
import { getToDirectory } from '../../common/ipfs-get.js'
import { createCarFromPath } from '../../core/unixfs/index.js'
import { runGet } from '../../get/get.js'

vi.mock('../../utils/cli-helpers.js', () => ({
  isInteractive: vi.fn(() => false),
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  createSpinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn(), clear: vi.fn() })),
}))

vi.mock('../../core/synapse/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/synapse/index.js')>()),
  initializeSynapse: vi.fn(async () => ({})),
}))

vi.mock('../../core/data-set/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/data-set/index.js')>()),
  listDataSets: vi.fn(async () => []),
}))

vi.mock('../../utils/cli-auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/cli-auth.js')>()),
  getCLILogger: vi.fn(),
}))

// Anvil development keys #0 and #1, as in Keysmith's pinned vectors.
const OWNER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const STRANGER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const OWNER = privateKeyToAccount(OWNER_KEY)
const GROUP_KEY = '0x00112233445566778899aabbccddeeff'
const MiB = 1024 * 1024
const GOOD = 'https://good.example'
const BAD = 'https://bad.example'

interface Block {
  cid: CID
  bytes: Uint8Array
}

/** The blocks of a builder CAR in the order a trustless gateway sends them: depth-first, each once. */
async function gatewayBlocks(carPath: string): Promise<{ root: CID; blocks: Block[] }> {
  const reader = await CarIndexedReader.fromFile(carPath)
  const [header] = await reader.getRoots()
  if (header == null) throw new Error('no root')
  const root = CID.decode(header.bytes)
  const blocks: Block[] = []
  const seen = new Set<string>()
  const walk = async (cid: CID): Promise<void> => {
    if (seen.has(cid.toString())) return
    seen.add(cid.toString())
    const block = await reader.get(cid as never)
    if (block == null) throw new Error(`missing ${cid}`)
    blocks.push({ cid, bytes: block.bytes })
    if (cid.code === dagPb.code) {
      for (const link of dagPb.decode(block.bytes).Links) await walk(CID.decode(link.Hash.bytes))
    }
  }
  await walk(root)
  await reader.close()
  return { root, blocks }
}

async function encodeCar(root: CID, blocks: Block[]): Promise<Uint8Array> {
  const { writer, out } = CarWriter.create([root as never])
  const chunks: Uint8Array[] = []
  const collected = (async () => {
    for await (const chunk of out) chunks.push(chunk)
  })()
  for (const block of blocks) await writer.put(block as never)
  await writer.close()
  await collected
  return Buffer.concat(chunks)
}

async function block(code: number, bytes: Uint8Array): Promise<Block> {
  return { cid: CID.create(1, code, await sha256.digest(bytes)), bytes }
}

const pbNode = (unixfs: UnixFS, links: dagPb.PBLink[] = []): Uint8Array =>
  dagPb.encode(dagPb.prepare({ Data: unixfs.marshal(), Links: links }))

interface Call {
  url: string
  signal: AbortSignal | undefined
}

type Handler = (signal: AbortSignal | undefined) => Promise<Response>

/** A fetch that answers IPNI with `ipni` multiaddrs and `<base>/ipfs/...` from `providers`; everything else 404s. */
function fakeNetwork(providers: Record<string, Handler>, ipni: string[] = []) {
  const calls: Call[] = []
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    calls.push({ url, signal: init?.signal ?? undefined })
    if (url.startsWith('https://cid.contact/cid/')) {
      if (ipni.length === 0) return new Response('not found', { status: 404 })
      return Response.json({ MultihashResults: [{ ProviderResults: [{ Provider: { ID: 'peer', Addrs: ipni } }] }] })
    }
    const base = Object.keys(providers).find((b) => url.startsWith(`${b}/ipfs/`))
    const handler = base == null ? undefined : providers[base]
    if (handler == null) return new Response('not found', { status: 404 })
    return handler(init?.signal ?? undefined)
  })
  const fetched = (base: string): Call[] => calls.filter((c) => c.url.startsWith(`${base}/ipfs/`))
  return { fetch: fetchFn as unknown as typeof fetch, calls, fetched }
}

const serve =
  (bytes: Uint8Array, delayMs = 0): Handler =>
  async (signal) => {
    if (delayMs > 0) await sleep(delayMs, undefined, signal == null ? {} : { signal })
    return new Response(new Uint8Array(bytes), { status: 200 })
  }

const only = (...urls: string[]) => [() => Promise.resolve(urls)]

describe('get', () => {
  let dir: string
  let tempDir: string
  let outDir: string
  let pieceKey: () => PieceKey

  beforeAll(async () => {
    const { kk, descriptor } = await deriveGroupKey(OWNER, { owner: OWNER.address, keyspace: GROUP_KEY })
    const target = writeTarget(descriptor, kk)
    pieceKey = () => newPieceKey(target)
  })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'filecoin-pin-get-test-'))
    tempDir = join(dir, 'tmp')
    await mkdir(tempDir, { mode: 0o700 })
    outDir = join(dir, 'out')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  })

  /** Pack `path` as `add` does and return the gateway CAR for it. */
  async function plainUpload(path: string): Promise<{ root: CID; blocks: Block[]; car: Uint8Array }> {
    const { carPath } = await createCarFromPath(path, { tempDir: dir })
    const { root, blocks } = await gatewayBlocks(carPath)
    await rm(carPath)
    return { root, blocks, car: await encodeCar(root, blocks) }
  }

  /** Encrypt `path` as `add --encrypt` does and return the gateway CAR for the envelope. */
  async function encryptedUpload(path: string): Promise<{ root: CID; blocks: Block[]; car: Uint8Array }> {
    const envelope = join(dir, 'encrypted.fee')
    await encryptPath(path, envelope, pieceKey())
    const upload = await plainUpload(envelope)
    await rm(envelope)
    return upload
  }

  const get = (
    root: CID,
    network: ReturnType<typeof fakeNetwork>,
    urls: string[],
    resolver = ownerKeyResolver(OWNER)
  ) => getToDirectory(root, outDir, only(...urls), resolver, { tempDir, fetch: network.fetch })

  describe('round trips', () => {
    it('decrypts an encrypted file whose envelope spans several leaves', async () => {
      const content = randomBytes(2.5 * MiB)
      await writeFile(join(dir, 'report.pdf'), content)
      const upload = await encryptedUpload(join(dir, 'report.pdf'))
      expect(upload.blocks.length).toBeGreaterThan(2)
      const network = fakeNetwork({ [GOOD]: serve(upload.car) })

      const result = await get(upload.root, network, [GOOD])

      expect(result).toMatchObject({ encrypted: true, files: 1, provider: GOOD })
      expect((await readFile(join(outDir, 'report.pdf'))).equals(content)).toBe(true)
    })

    it('decrypts an encrypted folder under its own name', async () => {
      const source = join(dir, 'photos')
      await mkdir(join(source, 'raw'), { recursive: true })
      const big = randomBytes(1.5 * MiB)
      await writeFile(join(source, 'raw', 'b.jpg'), big)
      await writeFile(join(source, 'a.jpg'), 'a')
      const upload = await encryptedUpload(source)
      const network = fakeNetwork({ [GOOD]: serve(upload.car) })

      await get(upload.root, network, [GOOD])

      expect(await readFile(join(outDir, 'photos', 'a.jpg'), 'utf8')).toBe('a')
      expect((await readFile(join(outDir, 'photos', 'raw', 'b.jpg'))).equals(big)).toBe(true)
    })

    it('writes a plain file as <out>/<cid>, owner-only, without asking for a key', async () => {
      const content = randomBytes(2.5 * MiB)
      await writeFile(join(dir, 'plain.bin'), content)
      const upload = await plainUpload(join(dir, 'plain.bin'))
      const network = fakeNetwork({ [GOOD]: serve(upload.car) })
      const resolver = vi.fn(ownerKeyResolver(OWNER))

      const result = await get(upload.root, network, [GOOD], resolver)

      expect(result).toMatchObject({ encrypted: false, files: 1, dirs: 0 })
      const written = join(outDir, upload.root.toString())
      expect((await readFile(written)).equals(content)).toBe(true)
      expect(resolver).not.toHaveBeenCalled()
      if (process.platform !== 'win32') {
        expect((await stat(outDir)).mode & 0o777).toBe(0o700)
        expect((await stat(written)).mode & 0o777).toBe(0o600)
      }
    })

    it('writes a small plain file with a raw root', async () => {
      await writeFile(join(dir, 'tiny.txt'), 'tiny')
      const upload = await plainUpload(join(dir, 'tiny.txt'))
      expect(upload.root.code).toBe(0x55)

      await get(upload.root, fakeNetwork({ [GOOD]: serve(upload.car) }), [GOOD])

      expect(await readFile(join(outDir, upload.root.toString()), 'utf8')).toBe('tiny')
    })

    it("writes a plain folder's contents under <out>", async () => {
      const source = join(dir, 'site')
      await mkdir(join(source, 'css', 'empty'), { recursive: true })
      const big = randomBytes(1.5 * MiB)
      await writeFile(join(source, 'index.html'), '<h1>hi</h1>')
      await writeFile(join(source, 'css', 'big.bin'), big)
      const upload = await plainUpload(source)

      const result = await get(upload.root, fakeNetwork({ [GOOD]: serve(upload.car) }), [GOOD])

      expect(result).toMatchObject({ encrypted: false, files: 2, dirs: 2 })
      expect(await readFile(join(outDir, 'index.html'), 'utf8')).toBe('<h1>hi</h1>')
      expect((await readFile(join(outDir, 'css', 'big.bin'))).equals(big)).toBe(true)
      expect((await stat(join(outDir, 'css', 'empty'))).isDirectory()).toBe(true)
    })

    it('writes a HAMT-sharded plain folder', async () => {
      const source = join(dir, 'many')
      await mkdir(source)
      const names = Array.from({ length: 1100 }, (_, i) => `${String(i).padStart(4, '0')}-${'n'.repeat(220)}.txt`)
      for (const name of names) await writeFile(join(source, name), name.slice(0, 4))
      const upload = await plainUpload(source)
      const rootNode = dagPb.decode(upload.blocks[0]?.bytes ?? new Uint8Array())
      expect(UnixFS.unmarshal(rootNode.Data ?? new Uint8Array()).type).toBe('hamt-sharded-directory')

      await get(upload.root, fakeNetwork({ [GOOD]: serve(upload.car) }), [GOOD])

      expect((await readdir(outDir)).sort()).toEqual(names)
      expect(await readFile(join(outDir, names[777] ?? ''), 'utf8')).toBe('0777')
    })
  })

  describe('verification', () => {
    let upload: { root: CID; blocks: Block[]; car: Uint8Array }
    let content: Buffer

    beforeEach(async () => {
      content = randomBytes(2.5 * MiB)
      await writeFile(join(dir, 'plain.bin'), content)
      upload = await plainUpload(join(dir, 'plain.bin'))
      // root, then three leaves
      expect(upload.blocks).toHaveLength(4)
    })

    const corruptions: Array<[string, (u: { root: CID; blocks: Block[]; car: Uint8Array }) => Promise<Uint8Array>]> = [
      [
        'a tampered block',
        (u) => {
          const blocks = u.blocks.map((b) => ({ ...b, bytes: new Uint8Array(b.bytes) }))
          const leaf = blocks[2]?.bytes
          if (leaf != null) leaf[100] = (leaf[100] ?? 0) ^ 0xff
          return encodeCar(u.root, blocks)
        },
      ],
      [
        'reordered blocks',
        (u) => {
          const [root, a, b, c] = u.blocks as [Block, Block, Block, Block]
          return encodeCar(u.root, [root, b, a, c])
        },
      ],
      ['an extra block', async (u) => encodeCar(u.root, [...u.blocks, await block(0x55, randomBytes(64))])],
      [
        'an unrelated block in place of a needed one',
        async (u) => encodeCar(u.root, [...u.blocks.slice(0, -1), await block(0x55, randomBytes(64))]),
      ],
      ['a missing block (Curio cut it short)', (u) => encodeCar(u.root, u.blocks.slice(0, -1))],
      ['bytes cut mid-block', async (u) => u.car.subarray(0, u.car.length - 100)],
      [
        'another root',
        async (u) => {
          const other = await block(0x55, randomBytes(64))
          return encodeCar(other.cid, u.blocks)
        },
      ],
    ]

    it.each(corruptions)('discards %s and uses the next provider', async (_case, corrupt) => {
      const network = fakeNetwork({ [BAD]: serve(await corrupt(upload)), [GOOD]: serve(upload.car, 50) })

      const result = await get(upload.root, network, [BAD, GOOD])

      expect(result.provider).toBe(GOOD)
      expect(network.fetched(BAD)).toHaveLength(1)
      expect((await readFile(join(outDir, upload.root.toString()))).equals(content)).toBe(true)
      expect(await readdir(tempDir)).toEqual(['download.car'])
    })

    it.each(corruptions)('fails with %s from the only provider and leaves nothing behind', async (_case, corrupt) => {
      const network = fakeNetwork({ [BAD]: serve(await corrupt(upload)) })

      await expect(get(upload.root, network, [BAD])).rejects.toBeInstanceOf(NoProviderError)

      expect(existsSync(outDir)).toBe(false)
      expect(await readdir(tempDir)).toEqual([])
    })

    it('rejects a hash function other than sha2-256 and identity', async () => {
      const leaf = upload.blocks[1] as Block
      const blake = CID.create(1, 0x55, Digest.create(0xb220, leaf.cid.multihash.digest))
      const root = await block(0x70, pbNode(new UnixFS({ type: 'file' }), [{ Hash: blake, Tsize: 1 } as never]))
      const network = fakeNetwork({
        [BAD]: serve(await encodeCar(root.cid, [root, { cid: blake, bytes: leaf.bytes }])),
      })

      await expect(get(root.cid, network, [BAD])).rejects.toBeInstanceOf(NoProviderError)
      expect(network.fetched(BAD)).toHaveLength(1)
    })
  })

  describe('providers', () => {
    let upload: { root: CID; blocks: Block[]; car: Uint8Array }

    beforeEach(async () => {
      await writeFile(join(dir, 'tiny.txt'), 'tiny')
      upload = await plainUpload(join(dir, 'tiny.txt'))
    })

    it('takes the first 200 and aborts every other request', async () => {
      const losers = ['https://slow.example', 'https://hang.example']
      const hang: Handler = (signal) =>
        new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)))
      const network = fakeNetwork({
        [GOOD]: serve(upload.car, 20),
        [losers[0] as string]: serve(upload.car, 5_000),
        [losers[1] as string]: hang,
      })

      const result = await get(upload.root, network, [...losers, GOOD])

      expect(result.provider).toBe(GOOD)
      for (const loser of losers) {
        const [call] = network.fetched(loser)
        expect(call?.signal?.aborted).toBe(true)
      }
      expect(network.fetched(GOOD)[0]?.signal?.aborted).toBe(false)
    })

    it(`keeps at most ${FETCH_CONCURRENCY} requests in flight`, async () => {
      let inFlight = 0
      let peak = 0
      const slow404: Handler = async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await sleep(20)
        inFlight--
        return new Response('no', { status: 404 })
      }
      const bases = Array.from({ length: 7 }, (_, i) => `https://sp${i}.example`)
      const network = fakeNetwork(Object.fromEntries(bases.map((b) => [b, slow404])))

      await expect(get(upload.root, network, bases)).rejects.toBeInstanceOf(NoProviderError)

      expect(peak).toBe(FETCH_CONCURRENCY)
      for (const base of bases) expect(network.fetched(base)).toHaveLength(1)
    })

    it('merges IPNI and own providers, de-duplicated, keeping only HTTP addresses', async () => {
      const ipni = ['/dns/sp1.example/tcp/443/https', '/dns/sp2.example/https', '/ip4/1.2.3.4/tcp/4001']
      const network = fakeNetwork({}, ipni)
      const { ipniProviderUrls } = await import('../../common/ipfs-car-fetch.js')

      await expect(
        getToDirectory(
          upload.root,
          outDir,
          [
            () => ipniProviderUrls(upload.root, { fetch: network.fetch }),
            () => Promise.resolve(['https://sp1.example/', 'https://sp3.example']),
          ],
          ownerKeyResolver(OWNER),
          { tempDir, fetch: network.fetch }
        )
      ).rejects.toThrow(NoProviderError)

      const tried = network.calls.filter((c) => c.url.includes('/ipfs/')).map((c) => new URL(c.url).origin)
      expect(tried.sort()).toEqual(['https://sp1.example', 'https://sp2.example', 'https://sp3.example'])
      expect(network.calls[0]?.url).toBe(`https://cid.contact/cid/${upload.root}`)
    })

    it('fails clearly when no provider serves the CID', async () => {
      const network = fakeNetwork({})

      await expect(get(upload.root, network, [])).rejects.toThrow(`No provider serves ${upload.root} over IPFS`)
      expect(existsSync(outDir)).toBe(false)
    })

    it('still tries the other source when one fails', async () => {
      const network = fakeNetwork({ [GOOD]: serve(upload.car) })

      const result = await getToDirectory(
        upload.root,
        outDir,
        [() => Promise.reject(new Error('rpc down')), () => Promise.resolve([GOOD])],
        ownerKeyResolver(OWNER),
        { tempDir, fetch: network.fetch }
      )

      expect(result.provider).toBe(GOOD)
    })
  })

  describe('content that is not a UnixFS file or directory', () => {
    it('fails on a dag-cbor root before any request', async () => {
      const network = fakeNetwork({})
      const cbor = CID.parse('bafyreigbtj4x7ip5legnfznufuopl4sg4knzc2cof6duas4b3q2fy6swua')

      await expect(get(cbor, network, [GOOD])).rejects.toBeInstanceOf(NotUnixfsError)
      expect(network.calls).toHaveLength(0)
      expect(existsSync(outDir)).toBe(false)
    })

    it('fails on a dag-pb root without UnixFS data and writes nothing', async () => {
      const root = await block(0x70, dagPb.encode({ Links: [] }))
      const network = fakeNetwork({ [GOOD]: serve(await encodeCar(root.cid, [root])) })

      await expect(get(root.cid, network, [GOOD])).rejects.toBeInstanceOf(NotUnixfsError)
      expect(existsSync(outDir)).toBe(false)
    })

    it('fails on a symlink inside a folder and removes what it wrote', async () => {
      const file = await block(0x55, new TextEncoder().encode('a'))
      const link = await block(0x70, pbNode(new UnixFS({ type: 'symlink', data: new TextEncoder().encode('/etc') })))
      const root = await block(
        0x70,
        pbNode(new UnixFS({ type: 'directory' }), [
          { Name: 'a.txt', Hash: file.cid, Tsize: 1 },
          { Name: 'evil', Hash: link.cid, Tsize: link.bytes.length },
        ] as never)
      )
      const network = fakeNetwork({ [GOOD]: serve(await encodeCar(root.cid, [root, file, link])) })

      await expect(get(root.cid, network, [GOOD])).rejects.toBeInstanceOf(NotUnixfsError)
      expect(existsSync(outDir)).toBe(false)
    })

    it('refuses an entry name that escapes the output directory', async () => {
      const file = await block(0x55, new TextEncoder().encode('owned'))
      const root = await block(
        0x70,
        pbNode(new UnixFS({ type: 'directory' }), [{ Name: '..', Hash: file.cid, Tsize: 5 }] as never)
      )
      const network = fakeNetwork({ [GOOD]: serve(await encodeCar(root.cid, [root, file])) })

      await expect(get(root.cid, network, [GOOD])).rejects.toThrow(/unsafe/)
      expect(existsSync(outDir)).toBe(false)
      expect(existsSync(join(dir, 'owned'))).toBe(false)
    })
  })

  describe('keys', () => {
    let upload: { root: CID; blocks: Block[]; car: Uint8Array }

    beforeEach(async () => {
      await writeFile(join(dir, 'secret.txt'), 'secret plaintext')
      upload = await encryptedUpload(join(dir, 'secret.txt'))
    })

    it('without a key, names the group key and writes nothing', async () => {
      const network = fakeNetwork({ [GOOD]: serve(upload.car) })

      await expect(
        get(
          upload.root,
          network,
          [GOOD],
          ownerKeyResolver(() => undefined)
        )
      ).rejects.toThrow(new RegExp(`belongs to ${OWNER.address} under group key ${GROUP_KEY}; set PRIVATE_KEY`, 'i'))
      expect(existsSync(outDir)).toBe(false)
    })

    it('with another wallet, names the group key and both addresses', async () => {
      const network = fakeNetwork({ [GOOD]: serve(upload.car) })
      const stranger = privateKeyToAccount(STRANGER_KEY)

      await expect(get(upload.root, network, [GOOD], ownerKeyResolver(stranger))).rejects.toThrow(
        new RegExp(`group key ${GROUP_KEY}; the wallet in PRIVATE_KEY is ${stranger.address}`, 'i')
      )
      expect(existsSync(outDir)).toBe(false)
    })
  })

  describe('runGet', () => {
    let logs: string[]

    beforeEach(async () => {
      logs = []
      const { getCLILogger } = await import('../../utils/cli-auth.js')
      const sink = new Writable({
        write(chunk, _encoding, callback) {
          logs.push(String(chunk))
          callback()
        },
      })
      vi.mocked(getCLILogger).mockReturnValue(pino({ level: 'trace' }, sink) as never)
    })

    it('asks IPNI only, with no credentials, and writes plain content', async () => {
      await writeFile(join(dir, 'tiny.txt'), 'tiny')
      const upload = await plainUpload(join(dir, 'tiny.txt'))
      const network = fakeNetwork({ [GOOD]: serve(upload.car) }, ['/dns/good.example/https'])
      vi.stubGlobal('fetch', network.fetch)
      const { initializeSynapse } = await import('../../core/synapse/index.js')

      await runGet(upload.root.toString(), outDir, {})

      expect(initializeSynapse).not.toHaveBeenCalled()
      expect(await readFile(join(outDir, upload.root.toString()), 'utf8')).toBe('tiny')
    })

    it("adds the providers of the address's live, IPFS-indexed data sets with pieces, read-only", async () => {
      await writeFile(join(dir, 'tiny.txt'), 'tiny')
      const upload = await plainUpload(join(dir, 'tiny.txt'))
      const network = fakeNetwork({ 'https://own.example': serve(upload.car) })
      vi.stubGlobal('fetch', network.fetch)
      const { initializeSynapse } = await import('../../core/synapse/index.js')
      const { listDataSets } = await import('../../core/data-set/index.js')
      const dataSet = (serviceURL: string, overrides: object) => ({
        isLive: true,
        hasActivePieces: true,
        metadata: { withIPFSIndexing: '' },
        provider: { pdp: { serviceURL } },
        ...overrides,
      })
      const dataSets = [
        dataSet('https://own.example/', {}),
        dataSet('https://dead.example', { isLive: false }),
        dataSet('https://empty.example', { hasActivePieces: false }),
        dataSet('https://no-ipfs.example', { metadata: {} }),
      ]
      vi.mocked(listDataSets).mockImplementation(
        async (_synapse, options) => dataSets.filter((d) => options?.filter?.(d as never) ?? true) as never
      )

      await runGet(upload.root.toString(), outDir, { privateKey: OWNER_KEY })

      expect(vi.mocked(initializeSynapse).mock.calls[0]?.[0]).toMatchObject({
        walletAddress: OWNER.address,
        readOnly: true,
      })
      expect(vi.mocked(initializeSynapse).mock.calls[0]?.[0]).not.toHaveProperty('privateKey')
      const tried = network.calls.filter((c) => c.url.includes('/ipfs/')).map((c) => new URL(c.url).origin)
      expect(tried).toEqual(['https://own.example'])
      expect(await readFile(join(outDir, upload.root.toString()), 'utf8')).toBe('tiny')
    })

    it.each([
      'SIGINT',
      'SIGTERM',
      'SIGHUP',
    ] as const)('on %s mid-download, leaves no output and no temp file', async (signal) => {
      const fakeTmp = join(dir, 'os-tmp')
      let tempBeforeSignal: string[] = []
      let tempAtExit: string[] | undefined
      // Snapshot at exit: the real process ends there, before any \`finally\`.
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
        tempAtExit = readdirSync(fakeTmp)
        throw new CliIncomplete('exit')
      })
      await mkdir(fakeTmp)
      vi.stubEnv('TMPDIR', fakeTmp)
      const stalling: Handler = async () => {
        let sent = false
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) {
              sent = true
              controller.enqueue(randomBytes(4096))
              return
            }
            tempBeforeSignal = readdirSync(fakeTmp)
            process.emit(signal)
          },
        })
        return new Response(body, { status: 200 })
      }
      const { cid: root } = await block(0x55, randomBytes(64))
      vi.stubGlobal('fetch', fakeNetwork({ [GOOD]: stalling }, ['/dns/good.example/https']).fetch)

      await expect(runGet(root.toString(), outDir, {})).rejects.toThrow()

      expect(exit).toHaveBeenCalledWith(EXIT_CODE_INCOMPLETE)
      expect(tempBeforeSignal).toHaveLength(1)
      expect(tempAtExit).toEqual([])
      expect(existsSync(outDir)).toBe(false)
      for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) expect(process.listenerCount(name)).toBe(0)
      vi.unstubAllEnvs()
    })

    it('never prints or logs the plaintext root CID', async () => {
      const source = join(dir, 'private-folder')
      await mkdir(source)
      await writeFile(join(source, 'diary.txt'), 'dear diary')
      const upload = await encryptedUpload(source)
      // The plaintext root, learned by decrypting once out of band.
      const envelope = join(dir, 'probe.fee')
      const { car } = upload
      const tampered = new Uint8Array(car)
      tampered[tampered.length - 10] = (tampered[tampered.length - 10] ?? 0) ^ 0xff
      const network = fakeNetwork({ [BAD]: serve(tampered), [GOOD]: serve(car, 50) }, [
        '/dns/bad.example/https',
        '/dns/good.example/https',
      ])
      vi.stubGlobal('fetch', network.fetch)
      const stdout = vi.spyOn(process.stdout, 'write')
      const stderr = vi.spyOn(process.stderr, 'write')
      const consoleCalls = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')]
      const helpers = await import('../../utils/cli-helpers.js')

      await expect(runGet(upload.root.toString(), outDir, { privateKey: STRANGER_KEY })).rejects.toThrow()
      await runGet(upload.root.toString(), outDir, { privateKey: OWNER_KEY })

      await encryptPath(source, envelope, pieceKey())
      const { root: plaintextRoot } = await decryptToDirectory(envelope, join(dir, 'probe'), ownerKeyResolver(OWNER))
      expect(await readFile(join(outDir, 'private-folder', 'diary.txt'), 'utf8')).toBe('dear diary')
      expect(logs.join('')).toContain('Discarded a provider response')
      const spinnerCalls = vi
        .mocked(helpers.createSpinner)
        .mock.results.flatMap((r) =>
          Object.values(r.value as Record<string, { mock?: { calls: unknown[][] } }>).flatMap(
            (fn) => fn.mock?.calls ?? []
          )
        )
      const printed = JSON.stringify([
        logs,
        stdout.mock.calls,
        stderr.mock.calls,
        consoleCalls.map((c) => c.mock.calls),
        vi.mocked(helpers.intro).mock.calls,
        vi.mocked(helpers.outro).mock.calls,
        vi.mocked(helpers.cancel).mock.calls,
        spinnerCalls,
      ])
      expect(printed).toContain(upload.root.toString())
      expect(printed).not.toContain(plaintextRoot)
    })
  })
})
