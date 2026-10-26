import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { keyspaceKeys as deriveGroupKey, writeTarget } from '@filoz/keysmith'
import { CarBlockIterator, CarIndexedReader } from '@ipld/car'
import * as fee from 'filecoin-encryption-envelope'
import { CID } from 'multiformats/cid'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliIncomplete, EXIT_CODE_INCOMPLETE } from '../../common/cli-errors.js'
import { decryptToDirectory, encryptPath, removeDecryptOutput, unixfsFileBytes } from '../../common/encryption.js'
import { newPieceKey, ownerKeyResolver, type PieceKey } from '../../common/group-key.js'
import { CAR_CONTENT_TYPE } from '../../common/unixfs-car-layout.js'
import { createCarFromPath } from '../../core/unixfs/index.js'
import { runDecrypt } from '../../decrypt/decrypt.js'
import { makeGrant, SESSION_KEY } from '../fixtures/group-key-grants.js'

// Lets a test act right after decrypt claims its entry, before anything is written into it.
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

vi.mock('../../utils/cli-helpers.js', () => ({
  isInteractive: vi.fn(() => false),
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  createSpinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn(), clear: vi.fn() })),
}))

// The well-known Anvil development keys #0 and #1, as in Keysmith's pinned vectors.
const OWNER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const STRANGER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const OWNER = privateKeyToAccount(OWNER_KEY)
const asOwner = { privateKey: OWNER_KEY }
const VECTOR_GROUP_KEY = '0x00112233445566778899aabbccddeeff'

async function drain(leaves: AsyncIterable<Uint8Array>): Promise<number> {
  let n = 0
  for await (const _ of leaves) n++
  return n
}

describe('runDecrypt', () => {
  let dir: string
  let plainPath: string
  let encryptedPath: string
  let outputDir: string
  const plaintext = randomBytes(64 * 1024)
  let pieceKey: () => PieceKey

  beforeAll(async () => {
    const { kk, descriptor } = await deriveGroupKey(OWNER, {
      owner: OWNER.address,
      keyspace: VECTOR_GROUP_KEY,
    })
    const target = writeTarget(descriptor, kk)
    pieceKey = () => newPieceKey(target)
  })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'filecoin-pin-decrypt-test-'))
    plainPath = join(dir, 'report.pdf')
    encryptedPath = join(dir, 'encrypted.fee')
    outputDir = join(dir, 'decrypted')
    await writeFile(plainPath, plaintext)
    await encryptPath(plainPath, encryptedPath, pieceKey())
  })

  afterEach(async () => {
    claimHook.after = undefined
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  // The CAR a gateway serves for `path`, moved into the test directory so nothing stays in $TMPDIR.
  async function outerCar(path: string): Promise<string> {
    const { carPath } = await createCarFromPath(path, {})
    const carInput = join(dir, 'download.car')
    await rename(carPath, carInput)
    return carInput
  }

  it('restores the file under its original name for the owner wallet', async () => {
    await runDecrypt(encryptedPath, outputDir, asOwner)

    expect((await readFile(join(outputDir, 'report.pdf'))).equals(plaintext)).toBe(true)
  })

  it('restores a directory upload with its name and tree', async () => {
    const source = join(dir, 'photos')
    await mkdir(join(source, 'raw'), { recursive: true })
    await writeFile(join(source, 'a.jpg'), 'a')
    await writeFile(join(source, 'raw', 'b.jpg'), 'b')
    await encryptPath(source, encryptedPath, pieceKey())

    await runDecrypt(encryptedPath, outputDir, asOwner)

    expect(await readFile(join(outputDir, 'photos', 'a.jpg'), 'utf8')).toBe('a')
    expect(await readFile(join(outputDir, 'photos', 'raw', 'b.jpg'), 'utf8')).toBe('b')
  })

  it.skipIf(process.platform === 'win32')('creates the output readable by its owner only', async () => {
    await runDecrypt(encryptedPath, outputDir, asOwner)

    expect((await stat(outputDir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(outputDir, 'report.pdf'))).mode & 0o777).toBe(0o600)
  })

  it('fails for another wallet, naming both addresses, and leaves no output behind', async () => {
    const stranger = privateKeyToAccount(STRANGER_KEY).address
    const both = new RegExp(`belongs to ${OWNER.address}.*PRIVATE_KEY is ${stranger}`, 'i')

    await expect(runDecrypt(encryptedPath, outputDir, { privateKey: STRANGER_KEY })).rejects.toThrow(both)
    expect(existsSync(outputDir)).toBe(false)
  })

  it('opens no network connection', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const connect = vi.spyOn(Socket.prototype, 'connect')

    await runDecrypt(encryptedPath, outputDir, asOwner)

    expect((await readFile(join(outputDir, 'report.pdf'))).equals(plaintext)).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it('refuses a session key without a Grant, naming the login to run', async () => {
    vi.stubEnv('GROUP_KEY_GRANT', '')
    const session = { walletAddress: OWNER.address, sessionKey: STRANGER_KEY }

    await expect(runDecrypt(encryptedPath, outputDir, session)).rejects.toThrow(
      /no group key Grant\. Run `filecoin-pin login --scopes createDataSet,addPieces,encrypt`/
    )
    expect(existsSync(outputDir)).toBe(false)
  })

  describe('with a session key and its Grant', () => {
    const session = { walletAddress: OWNER.address, sessionKey: SESSION_KEY, network: 'calibration' }
    const useGrant = async (groupKey: `0x${string}` = VECTOR_GROUP_KEY) => {
      vi.stubEnv('GROUP_KEY_GRANT', await makeGrant({ groupKey }))
      vi.stubEnv('GROUP_KEY_ID', groupKey)
    }
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it("restores the owner's upload offline", async () => {
      await useGrant()
      const connect = vi.spyOn(Socket.prototype, 'connect')

      await runDecrypt(encryptedPath, outputDir, session)

      expect((await readFile(join(outputDir, 'report.pdf'))).equals(plaintext)).toBe(true)
      expect(connect).not.toHaveBeenCalled()
    })

    it('fails for an upload under another group key, naming both', async () => {
      const other = `0x${'ab'.repeat(16)}` as const
      await useGrant(other)

      await expect(runDecrypt(encryptedPath, outputDir, session)).rejects.toThrow(
        new RegExp(`group key ${VECTOR_GROUP_KEY}; this session's Grant is for group key ${other}`)
      )
      expect(existsSync(outputDir)).toBe(false)
    })

    it('ignores a Grant for another network, with the login to run', async () => {
      await useGrant()

      await expect(runDecrypt(encryptedPath, outputDir, { ...session, network: 'mainnet' })).rejects.toThrow(
        /saved Grant was ignored: .*another network.*filecoin-pin login --scopes/
      )
    })
  })

  it('keeps a pre-existing empty directory on failure', async () => {
    await mkdir(outputDir, { mode: 0o755 })

    await expect(runDecrypt(encryptedPath, outputDir, { privateKey: STRANGER_KEY })).rejects.toThrow(/belongs to/)

    expect(existsSync(outputDir)).toBe(true)
    expect(await readdir(outputDir)).toEqual([])
  })

  it('decrypts into a non-empty directory, leaving what is there untouched', async () => {
    await mkdir(join(outputDir, 'notes'), { recursive: true })
    await writeFile(join(outputDir, 'keep.txt'), 'keep me')
    await writeFile(join(outputDir, 'notes', 'a.md'), '# a')

    await runDecrypt(encryptedPath, outputDir, asOwner)

    expect((await readFile(join(outputDir, 'report.pdf'))).equals(plaintext)).toBe(true)
    expect(await readFile(join(outputDir, 'keep.txt'), 'utf8')).toBe('keep me')
    expect(await readFile(join(outputDir, 'notes', 'a.md'), 'utf8')).toBe('# a')
    expect((await readdir(outputDir)).sort()).toEqual(['keep.txt', 'notes', 'report.pdf'])
  })

  it('numbers the file like a browser when its name is taken, and prints where it went', async () => {
    const { outro } = await import('../../utils/cli-helpers.js')
    await mkdir(outputDir)
    await writeFile(join(outputDir, 'report.pdf'), 'older report')

    await runDecrypt(encryptedPath, outputDir, asOwner)
    await runDecrypt(encryptedPath, outputDir, asOwner)

    expect(await readFile(join(outputDir, 'report.pdf'), 'utf8')).toBe('older report')
    expect((await readFile(join(outputDir, 'report(1).pdf'))).equals(plaintext)).toBe(true)
    expect((await readFile(join(outputDir, 'report(2).pdf'))).equals(plaintext)).toBe(true)
    expect(outro).toHaveBeenLastCalledWith(`Saved to ${join(outputDir, 'report(2).pdf')}`)
  })

  it('numbers a folder upload when the folder name is taken', async () => {
    const source = join(dir, 'photos')
    await mkdir(source)
    await writeFile(join(source, 'a.jpg'), 'new a')
    await encryptPath(source, encryptedPath, pieceKey())
    await mkdir(join(outputDir, 'photos'), { recursive: true })
    await writeFile(join(outputDir, 'photos', 'a.jpg'), 'old a')

    await runDecrypt(encryptedPath, outputDir, asOwner)

    expect(await readFile(join(outputDir, 'photos', 'a.jpg'), 'utf8')).toBe('old a')
    expect(await readFile(join(outputDir, 'photos(1)', 'a.jpg'), 'utf8')).toBe('new a')
  })

  it('removes only the claimed entry when decryption fails after the claim', async () => {
    // Several envelope chunks, so the claim happens on the first and the flipped byte fails a later one.
    await writeFile(plainPath, randomBytes(1.5 * 1024 * 1024))
    await encryptPath(plainPath, encryptedPath, pieceKey())
    const bytes = await readFile(encryptedPath)
    const i = bytes.length - 1000
    bytes[i] = (bytes[i] ?? 0) ^ 0x01
    await writeFile(encryptedPath, bytes)
    await mkdir(outputDir)
    await writeFile(join(outputDir, 'report.pdf'), 'older report')
    await writeFile(join(outputDir, 'keep.txt'), 'keep me')
    const claims: string[] = []
    claimHook.after = (path) => claims.push(path)

    await expect(runDecrypt(encryptedPath, outputDir, asOwner)).rejects.toThrow(/wrong key, or the file was modified/i)

    expect(claims).toEqual([join(outputDir, 'report(1).pdf')])
    expect((await readdir(outputDir)).sort()).toEqual(['keep.txt', 'report.pdf'])
    expect(await readFile(join(outputDir, 'report.pdf'), 'utf8')).toBe('older report')
  })

  it.each([
    ['no appMetadata', () => undefined],
    ['password-era metadata', () => ({ kdf: 'pbkdf2-sha256', iterations: 600_000, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' })],
    ['another label version', () => ({ ...pieceKey().appMetadata, 'foc/v': 2 })],
    ['a malformed salt', () => ({ ...pieceKey().appMetadata, 'foc/salt': 'not hex' })],
    ['a malformed group key id', () => ({ ...pieceKey().appMetadata, 'foc/ks': '0x1234' })],
  ])('rejects an envelope with %s', async (_case, labels) => {
    const appMetadata = labels()
    const foreign = new Blob([new Uint8Array(plaintext)])
      .stream()
      .pipeThrough(
        fee.encrypt({ cek: pieceKey().cek, contentType: CAR_CONTENT_TYPE, ...(appMetadata && { appMetadata }) })
      )
    await writeFile(encryptedPath, Buffer.from(await new Response(foreign).arrayBuffer()))

    await expect(runDecrypt(encryptedPath, outputDir, asOwner)).rejects.toThrow(
      'not encrypted by `filecoin-pin add --encrypt`'
    )
    expect(existsSync(outputDir)).toBe(false)
  })

  it('rejects an envelope whose payload is not the CAR profile', async () => {
    const { cek, appMetadata } = pieceKey()
    const rawPayload = new Blob([new Uint8Array(plaintext)]).stream().pipeThrough(fee.encrypt({ cek, appMetadata }))
    await writeFile(encryptedPath, Buffer.from(await new Response(rawPayload).arrayBuffer()))

    await expect(runDecrypt(encryptedPath, outputDir, asOwner)).rejects.toThrow(
      'not encrypted by `filecoin-pin add --encrypt`'
    )
    expect(existsSync(outputDir)).toBe(false)
  })

  it('accepts the outer CAR a gateway serves for the upload', async () => {
    const carInput = await outerCar(encryptedPath)

    await runDecrypt(carInput, outputDir, asOwner)

    expect((await readFile(join(outputDir, 'report.pdf'))).equals(plaintext)).toBe(true)
  })

  it('restores a directory upload from the outer CAR a gateway serves', async () => {
    const source = join(dir, 'photos')
    await mkdir(join(source, 'raw'), { recursive: true })
    const big = randomBytes(1.5 * 1024 * 1024)
    await writeFile(join(source, 'raw', 'b.jpg'), big)
    await writeFile(join(source, 'a.jpg'), 'a')
    await encryptPath(source, encryptedPath, pieceKey())

    await runDecrypt(await outerCar(encryptedPath), outputDir, asOwner)

    expect(await readFile(join(outputDir, 'photos', 'a.jpg'), 'utf8')).toBe('a')
    expect((await readFile(join(outputDir, 'photos', 'raw', 'b.jpg'))).equals(big)).toBe(true)
  })

  it('reports a flipped ciphertext byte as a wrong key or modified file', async () => {
    const bytes = await readFile(encryptedPath)
    const i = Math.floor(bytes.length / 2)
    bytes[i] = (bytes[i] ?? 0) ^ 0x01
    await writeFile(encryptedPath, bytes)

    await expect(runDecrypt(encryptedPath, outputDir, asOwner)).rejects.toThrow(/wrong key, or the file was modified/i)
    expect(existsSync(outputDir)).toBe(false)
  })

  it('reports a truncated envelope as an incomplete download', async () => {
    const bytes = await readFile(encryptedPath)
    await writeFile(encryptedPath, bytes.subarray(0, bytes.length - 100))

    await expect(runDecrypt(encryptedPath, outputDir, asOwner)).rejects.toThrow(/incomplete/)
    expect(existsSync(outputDir)).toBe(false)
  })

  it.each([
    ['a few bytes short', 50],
    ['cut in half', 32 * 1024],
  ])('reports an outer CAR %s as an incomplete download', async (_case, missing) => {
    const carInput = await outerCar(encryptedPath)
    const bytes = await readFile(carInput)
    await writeFile(carInput, bytes.subarray(0, bytes.length - missing))

    await expect(runDecrypt(carInput, outputDir, asOwner)).rejects.toThrow(/incomplete/)
    expect(existsSync(outputDir)).toBe(false)
  })

  it('reports a missing parent of the output directory', async () => {
    const nested = join(dir, 'missing', 'out')

    await expect(runDecrypt(encryptedPath, nested, asOwner)).rejects.toThrow(/Parent directory not found/)
    expect(existsSync(join(dir, 'missing'))).toBe(false)
  })

  it('decrypts the checked-in golden envelope with the Anvil owner key', async () => {
    // Encrypted once on 2026-10-20 under group key 0x00112233445566778899aabbccddeeff with
    // salt 0x000102030405060708090a0b0c0d0e0f, from Keysmith's pinned vectors.
    const golden = fileURLToPath(new URL('../fixtures/encrypted-golden/report.fee', import.meta.url))

    await runDecrypt(golden, outputDir, asOwner)

    expect(await readFile(join(outputDir, 'report', 'hello.txt'), 'utf8')).toBe('hello, filecoin\n')
    expect(await readFile(join(outputDir, 'report', 'notes', 'a.md'), 'utf8')).toBe('# a\n')
    expect(await readFile(join(outputDir, 'report', 'empty.bin'), 'utf8')).toBe('')
  })

  it.each([
    'SIGINT',
    'SIGTERM',
    'SIGHUP',
  ] as const)('on %s removes only the claimed entry and exits as incomplete', async (signal) => {
    // Simulate the real process: clack's handler exits, ours runs first because it was registered first.
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new CliIncomplete('exit')
    })
    await mkdir(outputDir)
    await writeFile(join(outputDir, 'report.pdf'), 'older report')
    await writeFile(join(outputDir, 'keep.txt'), 'keep me')
    // A real signal is delivered between event-loop turns, so the earliest it can land is the
    // first turn after the claim: before any content is written into the claimed file.
    claimHook.after = () =>
      setImmediate(() => {
        try {
          process.emit(signal)
        } catch {
          // The mocked exit threw; the real one never returns.
        }
      })

    // The real exit never returns; with it mocked the run carries on, so its outcome is moot.
    await runDecrypt(encryptedPath, outputDir, asOwner).catch(() => undefined)

    expect(exit).toHaveBeenCalledWith(EXIT_CODE_INCOMPLETE)
    expect((await readdir(outputDir)).sort()).toEqual(['keep.txt', 'report.pdf'])
    expect(await readFile(join(outputDir, 'report.pdf'), 'utf8')).toBe('older report')
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) expect(process.listenerCount(name)).toBe(0)
  })

  it('on a signal also removes the output directory it created, once empty', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new CliIncomplete('exit')
    })
    claimHook.after = () =>
      setImmediate(() => {
        try {
          process.emit('SIGTERM')
        } catch {
          // The mocked exit threw; the real one never returns.
        }
      })

    // The real exit never returns; with it mocked the run carries on, so its outcome is moot.
    await runDecrypt(encryptedPath, outputDir, asOwner).catch(() => undefined)

    expect(exit).toHaveBeenCalledWith(EXIT_CODE_INCOMPLETE)
    expect(existsSync(outputDir)).toBe(false)
  })

  it('keeps an output directory it created once something else was written into it', async () => {
    await mkdir(join(outputDir, 'report.pdf'), { recursive: true })
    await writeFile(join(outputDir, 'other.txt'), 'another writer')

    removeDecryptOutput(outputDir, true, join(outputDir, 'report.pdf'))

    expect(await readdir(outputDir)).toEqual(['other.txt'])
  })

  it('reports an output path that is a file', async () => {
    await writeFile(outputDir, 'a file')

    await expect(runDecrypt(encryptedPath, outputDir, asOwner)).rejects.toThrow(/exists and is not a directory/)
    expect(await readFile(outputDir, 'utf8')).toBe('a file')
  })

  it('reports a missing input before creating the output directory', async () => {
    await expect(runDecrypt(join(dir, 'missing.fee'), outputDir, asOwner)).rejects.toThrow(/Input file not found/)
    expect(existsSync(outputDir)).toBe(false)
  })

  it('decrypts the checked-in multi-chunk golden envelope and pins its inner root', async () => {
    // 1.1 MB of (i * 7919 + (i >> 8)) & 0xff, encrypted once on 2026-10-20 under the vector
    // group key with salt 0x101112131415161718191a1b1c1d1e1f. The root and the sha256 are
    // pinned from that run: a change to chunking, the wrapper or the labels must show up
    // here, not get regenerated.
    const golden = fileURLToPath(new URL('../fixtures/encrypted-golden/big.fee', import.meta.url))

    const result = await decryptToDirectory(golden, outputDir, ownerKeyResolver(OWNER))

    expect(result).toEqual({ files: 1, dirs: 0, bytes: 1_100_000, path: join(outputDir, 'big.bin') })
    const plaintext = new Blob([await readFile(golden)]).stream().pipeThrough(fee.decrypt(ownerKeyResolver(OWNER)))
    const roots = await (await CarBlockIterator.fromIterable(plaintext)).getRoots()
    expect(roots.map(String)).toEqual(['bafybeifi5o5cikl37er2zmvmbwgcsoh5df7q2q4soo6iwvlit7nstujohm'])
    const sha256 = createHash('sha256')
      .update(await readFile(join(outputDir, 'big.bin')))
      .digest('hex')
    expect(sha256).toBe('055f73580b10983d35429f869533fa41074a23477646ad9d09264b8be2fcc936')
  })

  it('reads the outer CAR one leaf at a time instead of ahead of the consumer', async () => {
    // 1.5 MiB splits into two UnixFS leaves, so a prefetching walker would read both.
    await writeFile(plainPath, randomBytes(1.5 * 1024 * 1024))
    await encryptPath(plainPath, encryptedPath, pieceKey())
    const reader = await CarIndexedReader.fromFile(await outerCar(encryptedPath))
    let reads = 0
    const counting = {
      get: async (cid: CID) => {
        reads++
        return reader.get(cid)
      },
    }
    const [root] = await reader.getRoots()
    expect(root).toBeDefined()

    const leaves = unixfsFileBytes(counting, root as CID)
    await leaves.next()

    // The root node plus the first leaf; nothing fetched ahead of what was pulled.
    expect(reads).toBeLessThanOrEqual(2)
    await leaves.return(undefined)
    await reader.close()
  })

  it('rejects an outer CAR whose root is a directory', async () => {
    const wrapped = join(dir, 'wrapped')
    await mkdir(wrapped)
    await copyFile(encryptedPath, join(wrapped, 'encrypted.fee'))
    const carInput = await outerCar(wrapped)

    await expect(runDecrypt(carInput, outputDir, asOwner)).rejects.toThrow(
      'not encrypted by `filecoin-pin add --encrypt`'
    )
    expect(existsSync(outputDir)).toBe(false)
  })

  it('rejects a link to a block the CAR does not carry', async () => {
    await writeFile(plainPath, randomBytes(1.5 * 1024 * 1024))
    await encryptPath(plainPath, encryptedPath, pieceKey())
    const reader = await CarIndexedReader.fromFile(await outerCar(encryptedPath))
    const [root] = await reader.getRoots()
    const rootOnly = { get: async (cid: CID) => (cid.equals(root as CID) ? reader.get(cid) : undefined) }

    await expect(drain(unixfsFileBytes(rootOnly, root as CID))).rejects.toThrow(/incomplete/)
    await reader.close()
  })

  it('rejects a block under a codec that is neither dag-pb nor raw', async () => {
    const cbor = CID.parse('bafyreigbtj4x7ip5legnfznufuopl4sg4knzc2cof6duas4b3q2fy6swua')
    const source = { get: async () => ({ bytes: new Uint8Array([0xa0]) }) }

    await expect(drain(unixfsFileBytes(source, cbor))).rejects.toThrow('not encrypted by `filecoin-pin add --encrypt`')
  })

  it('reports an outer CAR whose root block does not decode as not ours', async () => {
    const root = CID.parse('bafybeifi5o5cikl37er2zmvmbwgcsoh5df7q2q4soo6iwvlit7nstujohm')
    const source = { get: async () => ({ bytes: new Uint8Array([0xff, 0xff, 0xff]) }) }

    await expect(drain(unixfsFileBytes(source, root))).rejects.toThrow('not encrypted by `filecoin-pin add --encrypt`')
  })

  it('reports an input path that is a directory', async () => {
    await expect(runDecrypt(dir, outputDir, asOwner)).rejects.toThrow(/Input path is a directory/)
    expect(existsSync(outputDir)).toBe(false)
  })

  it('rejects a file that is not an envelope', async () => {
    await expect(runDecrypt(plainPath, outputDir, asOwner)).rejects.toThrow(
      'not encrypted by `filecoin-pin add --encrypt`'
    )
    expect(existsSync(outputDir)).toBe(false)
  })

  it('reads the owner key from --private-key or PRIVATE_KEY', async () => {
    const { decryptCommand } = await import('../../commands/decrypt.js')
    expect(decryptCommand.options.map((o) => o.long)).toContain('--private-key')
  })
})
