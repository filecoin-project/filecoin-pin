import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { keyspaceKeys as deriveGroupKey, writeTarget } from '@filoz/keysmith'
import { CarIndexedReader, CarWriter } from '@ipld/car'
import * as dagCbor from '@ipld/dag-cbor'
import * as dagPb from '@ipld/dag-pb'
import * as fee from 'filecoin-encryption-envelope'
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
import {
  BODY_IDLE_TIMEOUT_MS,
  DISCOVERY_TIMEOUT_MS,
  FETCH_CONCURRENCY,
  FetchFailedError,
  ipniProviderUrls,
  NoProviderError,
  NotUnixfsError,
  type ProviderSource,
  RESPONSE_TIMEOUT_MS,
  UnsupportedHashError,
} from '../../common/ipfs-car-fetch.js'
import { type GetOptions, getToDirectory, NotEnoughSpaceError } from '../../common/ipfs-get.js'
import { CAR_CONTENT_TYPE, encodeVarint, isUnsafeName } from '../../common/unixfs-car-layout.js'
import { createCarFromPath } from '../../core/unixfs/index.js'
import { runGet } from '../../get/get.js'

// Lets a test act right after get claims its entry, before anything is written into it.
const claimHook = vi.hoisted(() => ({ after: undefined as undefined | ((path: string) => void) }))
vi.mock('../../common/claim-output.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/claim-output.js')>()
  return {
    ...actual,
    claimEntry: (...args: Parameters<typeof actual.claimEntry>): string => {
      const path = actual.claimEntry(...args)
      claimHook.after?.(path)
      return path
    },
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, statfs: vi.fn(actual.statfs) }
})

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

/**
 * A fetch that answers IPNI with `ipni` multiaddrs (or a handler) and `<base>/ipfs/...` from
 * `providers`; everything else 404s.
 */
function fakeNetwork(providers: Record<string, Handler>, ipni: string[] | Handler = []) {
  const calls: Call[] = []
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    calls.push({ url, signal: init?.signal ?? undefined })
    if (url.startsWith('https://cid.contact/cid/')) {
      if (typeof ipni === 'function') return ipni(init?.signal ?? undefined)
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

const CAR_HEADERS = { 'content-type': `${CAR_CONTENT_TYPE}; version=1; order=dfs; dups=n` }

const serve =
  (bytes: Uint8Array, delayMs = 0): Handler =>
  async (signal) => {
    if (delayMs > 0) await sleep(delayMs, undefined, signal == null ? {} : { signal })
    return new Response(new Uint8Array(bytes), { status: 200, headers: CAR_HEADERS })
  }

/** Never answers; rejects once the request is aborted. */
const hang: Handler = (signal) =>
  new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)))

/** Hangs on the first request (until it is aborted), then serves `bytes`: the provider that loses the first race. */
function secondTime(bytes: Uint8Array): Handler {
  let calls = 0
  return (signal) => (++calls === 1 ? hang(signal) : serve(bytes)(signal))
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const only = (...urls: string[]): ProviderSource[] => [{ name: 'Test', find: async () => urls }]

/** A logger whose lines land in `lines`. */
function captureLogs(lines: string[]) {
  return pino(
    { level: 'trace' },
    new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk))
        callback()
      },
    })
  )
}

/** Every message and cause in an error chain, for checking what a caller could print. */
function errorChain(error: unknown): string {
  const parts: string[] = []
  for (let e: unknown = error; e != null; e = (e as { cause?: unknown }).cause) {
    parts.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e))
  }
  return parts.join(' <- ')
}

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
    vi.useRealTimers()
    vi.unstubAllEnvs()
    claimHook.after = undefined
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
    resolver = ownerKeyResolver(OWNER),
    options: Partial<GetOptions> = {}
  ) => getToDirectory(root, outDir, only(...urls), resolver, { tempDir, fetch: network.fetch, ...options })

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

    it('writes a plain folder as <out>/<cid>', async () => {
      const source = join(dir, 'site')
      await mkdir(join(source, 'css', 'empty'), { recursive: true })
      const big = randomBytes(1.5 * MiB)
      await writeFile(join(source, 'index.html'), '<h1>hi</h1>')
      await writeFile(join(source, 'css', 'big.bin'), big)
      const upload = await plainUpload(source)

      const result = await get(upload.root, fakeNetwork({ [GOOD]: serve(upload.car) }), [GOOD])

      const saved = join(outDir, upload.root.toString())
      expect(result).toMatchObject({ encrypted: false, files: 2, dirs: 2, path: saved })
      expect(await readdir(outDir)).toEqual([upload.root.toString()])
      expect(await readFile(join(saved, 'index.html'), 'utf8')).toBe('<h1>hi</h1>')
      expect((await readFile(join(saved, 'css', 'big.bin'))).equals(big)).toBe(true)
      expect((await stat(join(saved, 'css', 'empty'))).isDirectory()).toBe(true)
      if (process.platform !== 'win32') expect((await stat(saved)).mode & 0o777).toBe(0o700)
    })

    it('writes a HAMT-sharded plain folder', { timeout: 30_000 }, async () => {
      const source = join(dir, 'many')
      await mkdir(source)
      const names = Array.from({ length: 1100 }, (_, i) => `${String(i).padStart(4, '0')}-${'n'.repeat(220)}.txt`)
      for (const name of names) await writeFile(join(source, name), name.slice(0, 4))
      const upload = await plainUpload(source)
      const rootNode = dagPb.decode(upload.blocks[0]?.bytes ?? new Uint8Array())
      expect(UnixFS.unmarshal(rootNode.Data ?? new Uint8Array()).type).toBe('hamt-sharded-directory')

      await get(upload.root, fakeNetwork({ [GOOD]: serve(upload.car) }), [GOOD])

      const saved = join(outDir, upload.root.toString())
      expect((await readdir(saved)).sort()).toEqual(names)
      expect(await readFile(join(saved, names[777] ?? ''), 'utf8')).toBe('0777')
    })
  })

  describe('output directory', () => {
    it('saves into a non-empty directory, leaving what is there untouched', async () => {
      await writeFile(join(dir, 'tiny.txt'), 'tiny')
      const upload = await plainUpload(join(dir, 'tiny.txt'))
      await mkdir(join(outDir, 'old'), { recursive: true })
      await writeFile(join(outDir, 'keep.txt'), 'keep me')

      await get(upload.root, fakeNetwork({ [GOOD]: serve(upload.car) }), [GOOD])

      expect(await readFile(join(outDir, upload.root.toString()), 'utf8')).toBe('tiny')
      expect(await readFile(join(outDir, 'keep.txt'), 'utf8')).toBe('keep me')
      expect((await readdir(outDir)).sort()).toEqual([upload.root.toString(), 'keep.txt', 'old'].sort())
    })

    it('numbers a plain file when <cid> is taken: <cid>(1), then <cid>(2)', async () => {
      await writeFile(join(dir, 'tiny.txt'), 'tiny')
      const upload = await plainUpload(join(dir, 'tiny.txt'))
      const cid = upload.root.toString()
      await mkdir(outDir)
      await writeFile(join(outDir, cid), 'older copy')

      const first = await get(upload.root, fakeNetwork({ [GOOD]: serve(upload.car) }), [GOOD])
      // Each run gets a fresh temp dir; this one is reused, so drop the first download.
      await rm(join(tempDir, 'download.car'))
      const second = await get(upload.root, fakeNetwork({ [GOOD]: serve(upload.car) }), [GOOD])

      expect(first.path).toBe(join(outDir, `${cid}(1)`))
      expect(second.path).toBe(join(outDir, `${cid}(2)`))
      expect(await readFile(join(outDir, cid), 'utf8')).toBe('older copy')
      expect(await readFile(join(outDir, `${cid}(1)`), 'utf8')).toBe('tiny')
    })

    it('numbers an encrypted file under its original name', async () => {
      await writeFile(join(dir, 'report.pdf'), 'new report')
      const upload = await encryptedUpload(join(dir, 'report.pdf'))
      await mkdir(outDir)
      await writeFile(join(outDir, 'report.pdf'), 'older report')

      const result = await get(upload.root, fakeNetwork({ [GOOD]: serve(upload.car) }), [GOOD])

      expect(result.path).toBe(join(outDir, 'report(1).pdf'))
      expect(await readFile(join(outDir, 'report(1).pdf'), 'utf8')).toBe('new report')
      expect(await readFile(join(outDir, 'report.pdf'), 'utf8')).toBe('older report')
    })

    it('on failure removes only the claimed entry, leaving pre-existing files', async () => {
      const file = await block(0x55, new TextEncoder().encode('a'))
      const link = await block(0x70, pbNode(new UnixFS({ type: 'symlink', data: new TextEncoder().encode('/etc') })))
      const root = await block(
        0x70,
        pbNode(new UnixFS({ type: 'directory' }), [
          { Name: 'a.txt', Hash: file.cid, Tsize: 1 },
          { Name: 'evil', Hash: link.cid, Tsize: link.bytes.length },
        ] as never)
      )
      await mkdir(outDir)
      await writeFile(join(outDir, 'keep.txt'), 'keep me')
      await mkdir(join(outDir, root.cid.toString()))
      const claims: string[] = []
      claimHook.after = (path) => claims.push(path)
      const network = fakeNetwork({ [GOOD]: serve(await encodeCar(root.cid, [root, file, link])) })

      await expect(get(root.cid, network, [GOOD])).rejects.toBeInstanceOf(NotUnixfsError)

      expect(claims).toEqual([join(outDir, `${root.cid}(1)`)])
      expect((await readdir(outDir)).sort()).toEqual([root.cid.toString(), 'keep.txt'])
      expect(await readdir(join(outDir, root.cid.toString()))).toEqual([])
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
        'a duplicated block',
        (u) => {
          const [root, a, b, c] = u.blocks as [Block, Block, Block, Block]
          return encodeCar(u.root, [root, a, a, b, c])
        },
      ],
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
      // GOOD answers only once BAD's CAR has been rejected and the race runs again.
      const network = fakeNetwork({ [BAD]: serve(await corrupt(upload)), [GOOD]: secondTime(upload.car) })
      const logs: string[] = []

      const result = await get(upload.root, network, [BAD, GOOD], undefined, { logger: captureLogs(logs) })

      expect(result.provider).toBe(GOOD)
      expect(network.fetched(BAD)).toHaveLength(1)
      expect(network.fetched(GOOD)).toHaveLength(2)
      const discarded = logs.map((line) => JSON.parse(line)).filter((l) => l.msg === 'Discarded a provider response')
      expect(discarded.map((l) => l.provider)).toEqual([BAD])
      expect((await readFile(join(outDir, upload.root.toString()))).equals(content)).toBe(true)
      expect(await readdir(tempDir)).toEqual(['download.car'])
    })

    it.each(corruptions)('fails with %s from the only provider and leaves nothing behind', async (_case, corrupt) => {
      const network = fakeNetwork({ [BAD]: serve(await corrupt(upload)) })

      await expect(get(upload.root, network, [BAD])).rejects.toThrow(
        new RegExp(`^1 provider sent invalid data for ${upload.root}: `)
      )

      expect(existsSync(outDir)).toBe(false)
      expect(await readdir(tempDir)).toEqual([])
    })

    it('rejects a hash function other than sha2-256 and identity', async () => {
      const leaf = upload.blocks[1] as Block
      const blake = CID.create(1, 0x55, Digest.create(0xb220, leaf.cid.multihash.digest))
      const root = await block(0x70, pbNode(new UnixFS({ type: 'file' }), [{ Hash: blake, Tsize: 1 } as never]))
      const car = await encodeCar(root.cid, [root, { cid: blake, bytes: leaf.bytes }])
      const network = fakeNetwork({ [BAD]: serve(car), [GOOD]: serve(car) })

      const failure = get(root.cid, network, [BAD, GOOD], undefined, { concurrency: 1 })

      await expect(failure).rejects.toBeInstanceOf(UnsupportedHashError)
      await expect(failure).rejects.toThrow(`${blake} uses hash 0xb220; only sha2-256 and identity are supported`)
      // No provider can do better, so none is asked after the first.
      expect(network.fetched(GOOD)).toHaveLength(0)
      expect(existsSync(outDir)).toBe(false)
    })

    it('refuses a requested CID with another hash before any request', async () => {
      const blake = CID.create(1, 0x55, Digest.create(0xb220, new Uint8Array(32)))
      const network = fakeNetwork({ [GOOD]: serve(new Uint8Array()) })

      await expect(get(blake, network, [GOOD])).rejects.toBeInstanceOf(UnsupportedHashError)
      expect(network.calls).toHaveLength(0)
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

      await expect(
        getToDirectory(
          upload.root,
          outDir,
          [
            { name: 'IPNI', find: (signal) => ipniProviderUrls(upload.root, { fetch: network.fetch, signal }) },
            { name: 'Data set', find: async () => ['https://sp1.example/', 'https://sp3.example'] },
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

      await expect(get(upload.root, network, [GOOD])).rejects.toThrow(
        `No provider serves ${upload.root} over IPFS. If it was uploaded in the last few minutes, try again in about 20 minutes`
      )
      expect(existsSync(outDir)).toBe(false)
    })

    it('still tries the other source when one fails', async () => {
      const network = fakeNetwork({ [GOOD]: serve(upload.car) })

      const result = await getToDirectory(
        upload.root,
        outDir,
        [
          { name: 'Data set', find: () => Promise.reject(new Error('rpc down')) },
          { name: 'Test', find: async () => [GOOD] },
        ],
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

    it('fails on a dag-pb root without UnixFS data, writes nothing and asks no other provider', async () => {
      const root = await block(0x70, dagPb.encode({ Links: [] }))
      const car = await encodeCar(root.cid, [root])
      const network = fakeNetwork({ [BAD]: serve(car), [GOOD]: serve(car) })

      await expect(get(root.cid, network, [BAD, GOOD], undefined, { concurrency: 1 })).rejects.toBeInstanceOf(
        NotUnixfsError
      )
      expect(network.fetched(GOOD)).toHaveLength(0)
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
      vi.mocked(getCLILogger).mockReturnValue(captureLogs(logs) as never)
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

    it('saves into the current directory by default and prints the final path', async () => {
      await writeFile(join(dir, 'tiny.txt'), 'tiny')
      const upload = await plainUpload(join(dir, 'tiny.txt'))
      const cid = upload.root.toString()
      vi.stubGlobal('fetch', fakeNetwork({ [GOOD]: serve(upload.car) }, ['/dns/good.example/https']).fetch)
      await mkdir(outDir)
      await writeFile(join(outDir, cid), 'older copy')
      const { outro } = await import('../../utils/cli-helpers.js')
      const cwd = process.cwd()
      process.chdir(outDir)
      try {
        await runGet(cid, undefined, {})
      } finally {
        process.chdir(cwd)
      }

      expect(await readFile(join(outDir, `${cid}(1)`), 'utf8')).toBe('tiny')
      expect(await readFile(join(outDir, cid), 'utf8')).toBe('older copy')
      expect(outro).toHaveBeenLastCalledWith(`Saved to ${cid}(1)`)
    })

    it('on a signal after the claim removes only the claimed entry', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new CliIncomplete('exit')
      })
      const content = randomBytes(2.5 * MiB)
      await writeFile(join(dir, 'plain.bin'), content)
      const upload = await plainUpload(join(dir, 'plain.bin'))
      vi.stubGlobal('fetch', fakeNetwork({ [GOOD]: serve(upload.car) }, ['/dns/good.example/https']).fetch)
      await mkdir(outDir)
      await writeFile(join(outDir, 'keep.txt'), 'keep me')
      // A real signal is delivered between event-loop turns: the earliest is right after the claim.
      claimHook.after = () =>
        setImmediate(() => {
          try {
            process.emit('SIGTERM')
          } catch {
            // The mocked exit threw; the real one never returns.
          }
        })

      // The real exit never returns; with it mocked the run carries on, so its outcome is moot.
      await runGet(upload.root.toString(), outDir, {}).catch(() => undefined)

      expect(exit).toHaveBeenCalledWith(EXIT_CODE_INCOMPLETE)
      expect(await readdir(outDir)).toEqual(['keep.txt'])
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
        return new Response(body, { status: 200, headers: CAR_HEADERS })
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
      const network = fakeNetwork({ [BAD]: serve(tampered), [GOOD]: secondTime(car) }, [
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

  describe('timeouts', () => {
    let upload: { root: CID; blocks: Block[]; car: Uint8Array }

    beforeEach(async () => {
      await writeFile(join(dir, 'tiny.txt'), 'tiny')
      upload = await plainUpload(join(dir, 'tiny.txt'))
    })

    /** `handler`, resolving `started` when it is first called. */
    const noting = (started: { resolve: () => void }, handler: Handler): Handler => {
      return (signal) => {
        started.resolve()
        return handler(signal)
      }
    }

    it(`gives up on a provider that sends no headers within ${RESPONSE_TIMEOUT_MS / 1000} s`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const started = deferred()
      const network = fakeNetwork({ [BAD]: noting(started, hang) })
      let settled = false
      const failure = get(upload.root, network, [BAD]).finally(() => {
        settled = true
      })
      failure.catch(() => undefined)
      await started.promise

      await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)

      await expect(failure).rejects.toThrow(
        `Could not download ${upload.root} from 1 provider: no response in ${RESPONSE_TIMEOUT_MS / 1000} s`
      )
      expect(network.fetched(BAD)[0]?.signal?.aborted).toBe(true)
    })

    it('tries the next provider once the first sends no headers in time', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const started = deferred()
      const network = fakeNetwork({ [BAD]: noting(started, hang), [GOOD]: serve(upload.car) })
      const result = get(upload.root, network, [BAD, GOOD], undefined, { concurrency: 1 })
      await started.promise
      expect(network.fetched(GOOD)).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS)

      expect((await result).provider).toBe(GOOD)
    })

    /** A 200 whose body sends the first `head` bytes of `car`, then nothing, ever. */
    const stalls = (car: Uint8Array, head: number, stalled: { resolve: () => void }): Handler => {
      return async () => {
        let sent = false
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) {
              sent = true
              controller.enqueue(car.slice(0, head))
              return
            }
            stalled.resolve()
            return new Promise<void>(() => undefined)
          },
        })
        return new Response(body, { status: 200, headers: CAR_HEADERS })
      }
    }

    it(`drops a body that stalls for ${BODY_IDLE_TIMEOUT_MS / 1000} s and uses the next provider`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const stalled = deferred()
      const network = fakeNetwork({ [BAD]: stalls(upload.car, 20, stalled), [GOOD]: serve(upload.car) })
      const result = get(upload.root, network, [BAD, GOOD], undefined, { concurrency: 1 })
      await stalled.promise

      await vi.advanceTimersByTimeAsync(BODY_IDLE_TIMEOUT_MS)

      expect((await result).provider).toBe(GOOD)
      expect(network.fetched(BAD)[0]?.signal?.aborted).toBe(true)
      expect(await readdir(tempDir)).toEqual(['download.car'])
    })

    it('reports the stall when no other provider is left', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const stalled = deferred()
      const network = fakeNetwork({ [BAD]: stalls(upload.car, 20, stalled) })
      const failure = get(upload.root, network, [BAD])
      failure.catch(() => undefined)
      await stalled.promise

      await vi.advanceTimersByTimeAsync(BODY_IDLE_TIMEOUT_MS)

      await expect(failure).rejects.toThrow(`no data for ${BODY_IDLE_TIMEOUT_MS / 1000} s`)
      expect(await readdir(tempDir)).toEqual([])
    })

    it('stops waiting for a source that ignores its abort signal', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const started = deferred()
      const deaf: ProviderSource = {
        name: 'Data set',
        find: () => {
          started.resolve()
          return new Promise<string[]>(() => undefined)
        },
      }
      const failure = getToDirectory(upload.root, outDir, [deaf], ownerKeyResolver(OWNER), {
        tempDir,
        fetch: fakeNetwork({}).fetch,
      })
      failure.catch(() => undefined)
      await started.promise

      await vi.advanceTimersByTimeAsync(DISCOVERY_TIMEOUT_MS)

      await expect(failure).rejects.toThrow(`Data set lookup failed: timed out after ${DISCOVERY_TIMEOUT_MS / 1000} s`)
    })

    it('ends with a discovery error when IPNI never answers and no address is set', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const started = deferred()
      vi.stubGlobal('fetch', fakeNetwork({}, noting(started, hang)).fetch)
      const failure = runGet(upload.root.toString(), outDir, {})
      failure.catch(() => undefined)
      await started.promise

      await vi.advanceTimersByTimeAsync(DISCOVERY_TIMEOUT_MS)

      await expect(failure).rejects.toThrow(
        `Could not look up providers for ${upload.root}: IPNI lookup failed: timed out after ${DISCOVERY_TIMEOUT_MS / 1000} s`
      )
    })
  })

  describe('responses', () => {
    let upload: { root: CID; blocks: Block[]; car: Uint8Array }

    beforeEach(async () => {
      await writeFile(join(dir, 'tiny.txt'), 'tiny')
      upload = await plainUpload(join(dir, 'tiny.txt'))
    })

    it.each([206, 204])('does not accept HTTP %i', async (status) => {
      const body = status === 204 ? null : new Uint8Array(upload.car)
      const network = fakeNetwork({ [BAD]: async () => new Response(body, { status, headers: CAR_HEADERS }) })

      await expect(get(upload.root, network, [BAD])).rejects.toThrow(`from 1 provider: HTTP ${status}`)
      expect(existsSync(outDir)).toBe(false)
    })

    it('does not accept a response that is not a CAR', async () => {
      const network = fakeNetwork({
        [BAD]: async () => new Response(new Uint8Array(upload.car), { headers: { 'content-type': 'text/html' } }),
      })

      await expect(get(upload.root, network, [BAD])).rejects.toThrow('content type text/html, not a CAR')
    })

    it('fetches an origin listed by two sources at once only once', async () => {
      const network = fakeNetwork({ [GOOD]: serve(upload.car) })
      const sources: ProviderSource[] = [
        { name: 'IPNI', find: async () => [GOOD] },
        { name: 'Data set', find: async () => [`${GOOD}/`] },
      ]

      await getToDirectory(upload.root, outDir, sources, ownerKeyResolver(OWNER), { tempDir, fetch: network.fetch })

      expect(network.fetched(GOOD)).toHaveLength(1)
    })

    it('says which lookup failed, without URLs', async () => {
      const network = fakeNetwork({}, async () => new Response('busy', { status: 503 }))
      const sources: ProviderSource[] = [
        { name: 'IPNI', find: (signal) => ipniProviderUrls(upload.root, { fetch: network.fetch, signal }) },
        {
          name: 'Data set',
          find: () => Promise.reject(new Error('request to https://rpc.example/v1/SECRET-API-KEY failed')),
        },
      ]

      const failure = getToDirectory(upload.root, outDir, sources, ownerKeyResolver(OWNER), {
        tempDir,
        fetch: network.fetch,
      })

      const message = String(await failure.catch((e: unknown) => (e as Error).message))
      expect(message.startsWith(`Could not look up providers for ${upload.root}: `)).toBe(true)
      expect(message).toContain('IPNI lookup failed: HTTP 503')
      expect(message).toContain('Data set lookup failed: request to <url> failed')
      expect(message).not.toContain('SECRET')
      await expect(failure).rejects.toBeInstanceOf(FetchFailedError)
    })

    it('counts the providers that sent invalid data', async () => {
      const tampered = new Uint8Array(upload.car)
      tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff
      const network = fakeNetwork({ [BAD]: serve(tampered), [GOOD]: serve(tampered) })

      await expect(get(upload.root, network, [BAD, GOOD])).rejects.toThrow(
        new RegExp(`^2 providers sent invalid data for ${upload.root}: block \\S+ does not match its CID$`)
      )
    })

    it('treats an FEE envelope for something other than a CAR as a plain file', async () => {
      const { cek, appMetadata } = pieceKey()
      const sealed = new Blob([new TextEncoder().encode('not a CAR inside')])
        .stream()
        .pipeThrough(fee.encrypt({ cek, contentType: 'text/plain', appMetadata }))
      const envelope = Buffer.from(await new Response(sealed).arrayBuffer())
      await writeFile(join(dir, 'other.fee'), envelope)
      const other = await plainUpload(join(dir, 'other.fee'))
      const resolver = vi.fn(ownerKeyResolver(OWNER))

      const result = await get(other.root, fakeNetwork({ [GOOD]: serve(other.car) }), [GOOD], resolver)

      expect(result).toMatchObject({ encrypted: false, path: join(outDir, other.root.toString()) })
      expect((await readFile(result.path)).equals(envelope)).toBe(true)
      expect(resolver).not.toHaveBeenCalled()
    })
  })

  describe('CID forms', () => {
    let content: Buffer
    let upload: { root: CID; blocks: Block[]; car: Uint8Array }

    beforeEach(async () => {
      content = randomBytes(1.5 * MiB)
      await writeFile(join(dir, 'plain.bin'), content)
      upload = await plainUpload(join(dir, 'plain.bin'))
      expect(upload.root.code).toBe(0x70)
    })

    it('fetches a CIDv1 request from a CAR keyed by CIDv0', async () => {
      const v0 = upload.root.toV0()
      const [root, ...leaves] = upload.blocks as [Block, ...Block[]]
      const car = await encodeCar(v0, [{ cid: v0, bytes: root.bytes }, ...leaves])

      const result = await get(upload.root, fakeNetwork({ [GOOD]: serve(car) }), [GOOD])

      expect((await readFile(result.path)).equals(content)).toBe(true)
    })

    it('fetches a CIDv0 request from a CAR keyed by CIDv1', async () => {
      const v0 = upload.root.toV0()

      const result = await get(v0, fakeNetwork({ [GOOD]: serve(upload.car) }), [GOOD])

      expect(result.path).toBe(join(outDir, v0.toString()))
      expect((await readFile(result.path)).equals(content)).toBe(true)
    })

    describe('an identity dag-pb node with links', () => {
      let leaf: Block
      let root: Block

      beforeEach(async () => {
        leaf = await block(0x55, new TextEncoder().encode('inline parent, linked leaf'))
        const fileNode = pbNode(new UnixFS({ type: 'file', blockSizes: [BigInt(leaf.bytes.length)] }), [
          { Hash: leaf.cid, Tsize: leaf.bytes.length },
        ] as never)
        const inline = CID.create(1, 0x70, Digest.create(0x00, fileNode))
        root = await block(
          0x70,
          pbNode(new UnixFS({ type: 'directory' }), [{ Name: 'f.txt', Hash: inline, Tsize: fileNode.length }] as never)
        )
      })

      it('verifies the leaf a gateway sends for it', async () => {
        const network = fakeNetwork({ [GOOD]: serve(await encodeCar(root.cid, [root, leaf])) })

        const result = await get(root.cid, network, [GOOD])

        expect(await readFile(join(result.path, 'f.txt'), 'utf8')).toBe('inline parent, linked leaf')
      })

      it('treats a missing leaf as an incomplete download and tries the next provider', async () => {
        const network = fakeNetwork({
          [BAD]: serve(await encodeCar(root.cid, [root])),
          [GOOD]: secondTime(await encodeCar(root.cid, [root, leaf])),
        })

        const result = await get(root.cid, network, [BAD, GOOD])

        expect(result.provider).toBe(GOOD)
        expect(network.fetched(BAD)).toHaveLength(1)
      })
    })
  })

  describe('size limits', () => {
    let upload: { root: CID; blocks: Block[]; car: Uint8Array }

    beforeEach(async () => {
      await writeFile(join(dir, 'plain.bin'), randomBytes(1.5 * MiB))
      upload = await plainUpload(join(dir, 'plain.bin'))
    })

    it('refuses a declared Content-Length over the cap before reading the body', async () => {
      const pulled = vi.fn()
      const network = fakeNetwork({
        [BAD]: async () =>
          new Response(new ReadableStream({ pull: pulled }), {
            headers: { ...CAR_HEADERS, 'content-length': String(upload.car.length) },
          }),
      })

      await expect(get(upload.root, network, [BAD], undefined, { maxCarBytes: 1000 })).rejects.toThrow(
        `the CAR is ${upload.car.length} bytes, more than 1000`
      )
      expect(existsSync(outDir)).toBe(false)
    })

    it('stops a body that grows past the cap', async () => {
      const network = fakeNetwork({ [BAD]: serve(upload.car) })

      await expect(get(upload.root, network, [BAD], undefined, { maxCarBytes: 1000 })).rejects.toThrow(
        'the CAR is larger than 1000 bytes'
      )
      expect(await readdir(tempDir)).toEqual([])
    })

    it('refuses a section longer than the block limit before reading it', async () => {
      const header = dagCbor.encode({ version: 1, roots: [upload.root] })
      const forged = Buffer.concat([encodeVarint(header.length), header, encodeVarint(3 * MiB), randomBytes(64)])

      await expect(get(upload.root, fakeNetwork({ [BAD]: serve(forged) }), [BAD])).rejects.toThrow(
        `a CAR section is ${3 * MiB} bytes, more than the ${2 * MiB}-byte block limit`
      )
    })

    it('refuses a CARv2', async () => {
      const header = dagCbor.encode({ version: 2 })
      const v2 = Buffer.concat([encodeVarint(header.length), header, randomBytes(40)])

      await expect(get(upload.root, fakeNetwork({ [BAD]: serve(v2) }), [BAD])).rejects.toThrow(
        'CAR version 2; only CARv1 is accepted'
      )
    })

    it('refuses plain content larger than the free space, writing nothing', async () => {
      const { statfs } = await import('node:fs/promises')
      vi.mocked(statfs).mockResolvedValueOnce({ bavail: 1, bsize: 4096 } as never)

      const failure = get(upload.root, fakeNetwork({ [GOOD]: serve(upload.car) }), [GOOD])

      await expect(failure).rejects.toBeInstanceOf(NotEnoughSpaceError)
      await expect(failure).rejects.toThrow(`needs ${1.5 * MiB} bytes but only 4096 bytes are free in ${outDir}`)
      expect(existsSync(outDir)).toBe(false)
    })

    it('counts a leaf as often as it is linked', async () => {
      const leaf = upload.blocks[1] as Block
      const size = BigInt(leaf.bytes.length)
      const links = Array.from({ length: 1000 }, () => ({ Hash: leaf.cid, Tsize: leaf.bytes.length }))
      const bomb = await block(
        0x70,
        pbNode(new UnixFS({ type: 'file', blockSizes: links.map(() => size) }), links as never)
      )
      const { statfs } = await import('node:fs/promises')
      vi.mocked(statfs).mockResolvedValueOnce({ bavail: 10 * MiB, bsize: 1 } as never)

      const failure = get(bomb.cid, fakeNetwork({ [GOOD]: serve(await encodeCar(bomb.cid, [bomb, leaf])) }), [GOOD])

      await expect(failure).rejects.toThrow(`needs ${1000n * size} bytes but only ${10 * MiB} bytes are free`)
      expect(existsSync(outDir)).toBe(false)
    })
  })

  describe('isUnsafeName', () => {
    it.each([
      'CON',
      'con.txt',
      'nul',
      'COM1.log',
      'LPT9',
      'a:b',
      'what?',
      'a*b',
      'x<y',
      'x>y',
      'say"hi"',
      'pipe|d',
      'tab\there',
      'dot.',
      'space ',
    ])('refuses %j on Windows', (name) => {
      expect(isUnsafeName(name, 'win32')).toBe(true)
    })

    it.each(['CON', 'a:b', 'dot.', 'space '])('keeps %j elsewhere', (name) => {
      expect(isUnsafeName(name, 'linux')).toBe(false)
      expect(isUnsafeName(name, 'darwin')).toBe(false)
    })

    it.each(['console.txt', 'COM10', 'report.pdf', '.env'])('keeps %j on Windows', (name) => {
      expect(isUnsafeName(name, 'win32')).toBe(false)
    })

    it.each(['', '.', '..', 'a/b', 'a\\b', 'a\0b'])('refuses %j everywhere', (name) => {
      expect(isUnsafeName(name, 'linux')).toBe(true)
      expect(isUnsafeName(name, 'win32')).toBe(true)
    })
  })

  describe('runGet cleanup', () => {
    let osTmp: string

    beforeEach(async () => {
      osTmp = join(dir, 'os-tmp')
      await mkdir(osTmp)
      vi.stubEnv('TMPDIR', osTmp)
      vi.stubEnv('TEMP', osTmp)
      vi.stubEnv('TMP', osTmp)
      const { getCLILogger } = await import('../../utils/cli-auth.js')
      vi.mocked(getCLILogger).mockReturnValue(captureLogs([]) as never)
    })

    it('leaves the temp dir empty after a success and after a failure', async () => {
      await writeFile(join(dir, 'tiny.txt'), 'tiny')
      const upload = await plainUpload(join(dir, 'tiny.txt'))
      vi.stubGlobal('fetch', fakeNetwork({ [GOOD]: serve(upload.car) }, ['/dns/good.example/https']).fetch)

      await runGet(upload.root.toString(), outDir, {})
      expect(await readdir(osTmp)).toEqual([])

      vi.stubGlobal('fetch', fakeNetwork({}).fetch)
      await expect(runGet(upload.root.toString(), outDir, {})).rejects.toThrow(/No provider serves/)
      expect(await readdir(osTmp)).toEqual([])
    })

    it('keeps an output dir it created once another writer put something in it', async () => {
      const file = await block(0x55, new TextEncoder().encode('a'))
      const link = await block(0x70, pbNode(new UnixFS({ type: 'symlink', data: new TextEncoder().encode('/etc') })))
      const root = await block(
        0x70,
        pbNode(new UnixFS({ type: 'directory' }), [
          { Name: 'a.txt', Hash: file.cid, Tsize: 1 },
          { Name: 'evil', Hash: link.cid, Tsize: link.bytes.length },
        ] as never)
      )
      const car = await encodeCar(root.cid, [root, file, link])
      vi.stubGlobal('fetch', fakeNetwork({ [GOOD]: serve(car) }, ['/dns/good.example/https']).fetch)
      claimHook.after = () => writeFileSync(join(outDir, 'theirs.txt'), 'not ours')

      await expect(runGet(root.cid.toString(), outDir, {})).rejects.toThrow(/symlink/)

      expect(await readdir(outDir)).toEqual(['theirs.txt'])
    })

    it('never surfaces an entry name from inside a failing envelope', async () => {
      // A plaintext CAR whose folder `secret-inner-name` holds an entry named `..`: unpacking
      // refuses it with an error naming the folder.
      const leaf = await block(0x55, new TextEncoder().encode('x'))
      const inner = await block(
        0x70,
        pbNode(new UnixFS({ type: 'directory' }), [{ Name: '..', Hash: leaf.cid, Tsize: 1 }] as never)
      )
      const wrapper = await block(
        0x70,
        pbNode(new UnixFS({ type: 'directory' }), [
          { Name: 'secret-inner-name', Hash: inner.cid, Tsize: inner.bytes.length },
        ] as never)
      )
      const plaintext = await encodeCar(wrapper.cid, [wrapper, inner, leaf])
      const { cek, appMetadata } = pieceKey()
      const sealed = new Blob([new Uint8Array(plaintext)])
        .stream()
        .pipeThrough(fee.encrypt({ cek, contentType: CAR_CONTENT_TYPE, appMetadata }))
      await writeFile(join(dir, 'crafted.fee'), Buffer.from(await new Response(sealed).arrayBuffer()))
      const upload = await plainUpload(join(dir, 'crafted.fee'))
      vi.stubGlobal('fetch', fakeNetwork({ [GOOD]: serve(upload.car) }, ['/dns/good.example/https']).fetch)
      const helpers = await import('../../utils/cli-helpers.js')

      const error = await runGet(upload.root.toString(), outDir, { privateKey: OWNER_KEY }).catch((e: unknown) => e)

      expect(errorChain(error)).toContain('malformed or unsafe to unpack')
      const printed = JSON.stringify([
        errorChain(error),
        vi.mocked(helpers.cancel).mock.calls,
        vi.mocked(helpers.createSpinner).mock.results.map((r) => (r.value as { stop: { mock: unknown } }).stop.mock),
      ])
      expect(printed).not.toContain('secret-inner-name')
    })
  })
})
