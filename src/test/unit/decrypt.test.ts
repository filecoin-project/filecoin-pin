import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fee from 'filecoin-encryption-envelope'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliIncomplete, EXIT_CODE_INCOMPLETE } from '../../common/cli-errors.js'
import { encryptPathWithPassword } from '../../common/encryption.js'
import { CAR_CONTENT_TYPE } from '../../common/unixfs-car-layout.js'
import { createCarFromPath } from '../../core/unixfs/index.js'
import { runDecrypt } from '../../decrypt/decrypt.js'

vi.mock('../../utils/cli-helpers.js', () => ({
  isInteractive: vi.fn(() => false),
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  createSpinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn(), clear: vi.fn() })),
}))

vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clack/prompts')>()),
  isCancel: vi.fn(() => false),
  password: vi.fn(),
}))

const PASSWORD = 'correct horse battery staple'

describe('runDecrypt', () => {
  let dir: string
  let plainPath: string
  let encryptedPath: string
  let outputDir: string
  const plaintext = randomBytes(1024 * 1024 * 1.5)

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'filecoin-pin-decrypt-test-'))
    plainPath = join(dir, 'report.pdf')
    encryptedPath = join(dir, 'encrypted.fee')
    outputDir = join(dir, 'decrypted')
    await writeFile(plainPath, plaintext)
    await encryptPathWithPassword(plainPath, encryptedPath, PASSWORD)
    process.env.FILECOIN_PIN_PASSWORD = PASSWORD
  })

  afterEach(async () => {
    delete process.env.FILECOIN_PIN_PASSWORD
    vi.clearAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('restores the file under its original name when given the upload password', async () => {
    await runDecrypt(encryptedPath, outputDir, {})

    expect((await readFile(join(outputDir, 'report.pdf'))).equals(plaintext)).toBe(true)
  })

  it('restores a directory upload with its name and tree', async () => {
    const source = join(dir, 'photos')
    await mkdir(join(source, 'raw'), { recursive: true })
    await writeFile(join(source, 'a.jpg'), 'a')
    await writeFile(join(source, 'raw', 'b.jpg'), 'b')
    await encryptPathWithPassword(source, encryptedPath, PASSWORD)

    await runDecrypt(encryptedPath, outputDir, {})

    expect(await readFile(join(outputDir, 'photos', 'a.jpg'), 'utf8')).toBe('a')
    expect(await readFile(join(outputDir, 'photos', 'raw', 'b.jpg'), 'utf8')).toBe('b')
  })

  it.skipIf(process.platform === 'win32')('creates the output readable by its owner only', async () => {
    await runDecrypt(encryptedPath, outputDir, {})

    expect((await stat(outputDir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(outputDir, 'report.pdf'))).mode & 0o777).toBe(0o600)
  })

  it('fails on a wrong password and leaves no output behind', async () => {
    process.env.FILECOIN_PIN_PASSWORD = 'wrong password'

    await expect(runDecrypt(encryptedPath, outputDir, {})).rejects.toThrow(/wrong password/i)
    expect(existsSync(outputDir)).toBe(false)
  })

  it('decrypts into an existing empty directory and keeps it on failure', async () => {
    await mkdir(outputDir, { mode: 0o755 })

    process.env.FILECOIN_PIN_PASSWORD = 'wrong password'
    await expect(runDecrypt(encryptedPath, outputDir, {})).rejects.toThrow(/wrong password/i)
    expect(existsSync(outputDir)).toBe(true)
    expect(await readdir(outputDir)).toEqual([])

    process.env.FILECOIN_PIN_PASSWORD = PASSWORD
    await runDecrypt(encryptedPath, outputDir, {})
    expect((await readFile(join(outputDir, 'report.pdf'))).equals(plaintext)).toBe(true)
  })

  it('refuses a non-empty output directory', async () => {
    await mkdir(outputDir)
    await writeFile(join(outputDir, 'keep.txt'), 'keep me')

    await expect(runDecrypt(encryptedPath, outputDir, {})).rejects.toThrow(/not empty/)
    expect(await readFile(join(outputDir, 'keep.txt'), 'utf8')).toBe('keep me')
  })

  it.each([
    ['no appMetadata', undefined],
    ['another kdf', { kdf: 'argon2id', iterations: 3, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }],
    ['an unreasonable iteration count', { kdf: 'pbkdf2-sha256', iterations: 1e12, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }],
  ])('rejects an envelope with %s', async (_case, appMetadata) => {
    const cek = crypto.getRandomValues(new Uint8Array(fee.constants.KEY_SIZE))
    const foreign = new Blob([new Uint8Array(plaintext)])
      .stream()
      .pipeThrough(fee.encrypt({ cek, contentType: CAR_CONTENT_TYPE, ...(appMetadata && { appMetadata }) }))
    await writeFile(encryptedPath, Buffer.from(await new Response(foreign).arrayBuffer()))

    await expect(runDecrypt(encryptedPath, outputDir, {})).rejects.toThrow(
      'not encrypted by `filecoin-pin add --encrypt`'
    )
    expect(existsSync(outputDir)).toBe(false)
  })

  it('rejects an envelope whose payload is not the CAR profile', async () => {
    const cek = crypto.getRandomValues(new Uint8Array(fee.constants.KEY_SIZE))
    const appMetadata = { kdf: 'pbkdf2-sha256', iterations: 600_000, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }
    const rawPayload = new Blob([new Uint8Array(plaintext)]).stream().pipeThrough(fee.encrypt({ cek, appMetadata }))
    await writeFile(encryptedPath, Buffer.from(await new Response(rawPayload).arrayBuffer()))

    await expect(runDecrypt(encryptedPath, outputDir, {})).rejects.toThrow(
      'not encrypted by `filecoin-pin add --encrypt`'
    )
    expect(existsSync(outputDir)).toBe(false)
  })

  it('accepts the outer CAR a gateway serves for the upload', async () => {
    const { carPath } = await createCarFromPath(encryptedPath, {})
    const carInput = join(dir, 'download.car')
    await rm(carInput, { force: true })
    await (await import('node:fs/promises')).rename(carPath, carInput)

    await runDecrypt(carInput, outputDir, {})

    expect((await readFile(join(outputDir, 'report.pdf'))).equals(plaintext)).toBe(true)
  })

  it('reports a flipped ciphertext byte as a wrong password or modified file', async () => {
    const bytes = await readFile(encryptedPath)
    const i = Math.floor(bytes.length / 2)
    bytes[i] = (bytes[i] ?? 0) ^ 0x01
    await writeFile(encryptedPath, bytes)

    await expect(runDecrypt(encryptedPath, outputDir, {})).rejects.toThrow(/wrong password, or the file was modified/i)
    expect(existsSync(outputDir)).toBe(false)
  })

  it('reports a truncated envelope as an incomplete download', async () => {
    const bytes = await readFile(encryptedPath)
    await writeFile(encryptedPath, bytes.subarray(0, bytes.length - 100))

    await expect(runDecrypt(encryptedPath, outputDir, {})).rejects.toThrow(/incomplete/)
    expect(existsSync(outputDir)).toBe(false)
  })

  it.each([
    ['a salt that is not 16 bytes', { kdf: 'pbkdf2-sha256', iterations: 600_000, salt: 'AAAA' }],
    ['a non-canonical salt', { kdf: 'pbkdf2-sha256', iterations: 600_000, salt: 'AAAAAAAAAAAAAAAAAAAAAB==' }],
    ['zero iterations', { kdf: 'pbkdf2-sha256', iterations: 0, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }],
    ['negative iterations', { kdf: 'pbkdf2-sha256', iterations: -1, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }],
  ])('rejects an envelope with %s', async (_case, appMetadata) => {
    const cek = crypto.getRandomValues(new Uint8Array(fee.constants.KEY_SIZE))
    const foreign = new Blob([new Uint8Array(plaintext)])
      .stream()
      .pipeThrough(fee.encrypt({ cek, contentType: CAR_CONTENT_TYPE, appMetadata }))
    await writeFile(encryptedPath, Buffer.from(await new Response(foreign).arrayBuffer()))

    await expect(runDecrypt(encryptedPath, outputDir, {})).rejects.toThrow(
      'not encrypted by `filecoin-pin add --encrypt`'
    )
  })

  it('decrypts the checked-in golden envelope', async () => {
    const golden = fileURLToPath(new URL('../fixtures/encrypted-golden/report.fee', import.meta.url))
    process.env.FILECOIN_PIN_PASSWORD = 'golden password 2026-10-15'

    await runDecrypt(golden, outputDir, {})

    expect(await readFile(join(outputDir, 'report', 'hello.txt'), 'utf8')).toBe('hello, filecoin\n')
    expect(await readFile(join(outputDir, 'report', 'notes', 'a.md'), 'utf8')).toBe('# a\n')
    expect(await readFile(join(outputDir, 'report', 'empty.bin'), 'utf8')).toBe('')
  })

  it('removes what it wrote on Ctrl-C, keeps a pre-existing directory, and exits as incomplete', async () => {
    // Simulate the real process: clack's handler exits, ours runs first because it was registered first.
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new CliIncomplete('exit')
    })
    await mkdir(outputDir)
    await writeFile(join(outputDir, 'partial.bin'), 'half-written plaintext')
    const { createSpinner } = await import('../../utils/cli-helpers.js')
    vi.mocked(createSpinner).mockReturnValueOnce({
      start: vi.fn(() => process.emit('SIGINT')),
      stop: vi.fn(),
      message: vi.fn(),
      clear: vi.fn(),
    } as never)

    await expect(runDecrypt(encryptedPath, outputDir, {})).rejects.toBeInstanceOf(CliIncomplete)

    expect(exit).toHaveBeenCalledWith(EXIT_CODE_INCOMPLETE)
    expect(existsSync(join(outputDir, 'partial.bin'))).toBe(false)
    expect(existsSync(outputDir)).toBe(true)
    expect(process.listenerCount('SIGINT')).toBe(0)
  })

  it('rejects a file that is not an envelope', async () => {
    await expect(runDecrypt(plainPath, outputDir, {})).rejects.toThrow('not encrypted by `filecoin-pin add --encrypt`')
    expect(existsSync(outputDir)).toBe(false)
  })

  it('treats a cancelled password prompt as incomplete', async () => {
    delete process.env.FILECOIN_PIN_PASSWORD
    const { isInteractive } = await import('../../utils/cli-helpers.js')
    const { isCancel } = await import('@clack/prompts')
    vi.mocked(isInteractive).mockReturnValueOnce(true)
    vi.mocked(isCancel).mockReturnValueOnce(true)

    await expect(runDecrypt(encryptedPath, outputDir, {})).rejects.toBeInstanceOf(CliIncomplete)
    expect(existsSync(outputDir)).toBe(false)
  })
})
