import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claimEntry, NoFreeNameError, numberedName } from '../../common/claim-output.js'

const run = promisify(execFile)

describe('numberedName', () => {
  it.each([
    ['report.pdf', 'file', 'report(1).pdf'],
    ['archive.tar.gz', 'file', 'archive(1).tar.gz'],
    ['data.csv.GZ', 'file', 'data(1).csv.GZ'],
    ['backup.tar.zst', 'file', 'backup(1).tar.zst'],
    ['node-v24.1.0-darwin-arm64.tar.gz', 'file', 'node-v24.1.0-darwin-arm64(1).tar.gz'],
    ['log.2026-10-23.gz', 'file', 'log.2026-10-23(1).gz'],
    ['notes.gz', 'file', 'notes(1).gz'],
    ['report.v2.pdf', 'file', 'report.v2(1).pdf'],
    ['jquery.min.js', 'file', 'jquery.min(1).js'],
    ['README', 'file', 'README(1)'],
    ['.env', 'file', '.env(1)'],
    ['.config.json', 'file', '.config(1).json'],
    ['.tar.gz', 'file', '.tar(1).gz'],
    ['photos', 'folder', 'photos(1)'],
    ['v1.2', 'folder', 'v1.2(1)'],
    ['archive.tar.gz', 'folder', 'archive.tar.gz(1)'],
  ] as const)('numbers %s (%s) as %s', (name, kind, expected) => {
    expect(numberedName(name, 0, kind)).toBe(name)
    expect(numberedName(name, 1, kind)).toBe(expected)
  })
})

describe('claimEntry', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'filecoin-pin-claim-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('takes the name itself, then (1), then (2), leaving taken entries untouched', async () => {
    writeFileSync(join(dir, 'report.pdf'), 'mine')

    expect(claimEntry(dir, 'report.pdf', 'file')).toBe(join(dir, 'report(1).pdf'))
    expect(claimEntry(dir, 'report.pdf', 'file')).toBe(join(dir, 'report(2).pdf'))
    expect(await readFile(join(dir, 'report.pdf'), 'utf8')).toBe('mine')
    expect(await readFile(join(dir, 'report(1).pdf'), 'utf8')).toBe('')
  })

  it.skipIf(process.platform === 'win32')('creates a file 0600 and a folder 0700', async () => {
    const file = claimEntry(dir, 'a.txt', 'file')
    const folder = claimEntry(dir, 'photos', 'folder')

    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(folder)).isDirectory()).toBe(true)
    expect((await stat(folder)).mode & 0o777).toBe(0o700)
  })

  it('numbers a folder past a file of the same name', () => {
    writeFileSync(join(dir, 'photos'), 'a file')

    expect(claimEntry(dir, 'photos', 'folder')).toBe(join(dir, 'photos(1)'))
  })

  it('gives up with a clear error once every numbered name is taken', () => {
    mkdirSync(join(dir, 'x'))
    for (let n = 1; n < 1000; n++) mkdirSync(join(dir, `x(${n})`))

    expect(() => claimEntry(dir, 'x', 'folder')).toThrow(NoFreeNameError)
  })

  it('rethrows errors other than EEXIST', () => {
    expect(() => claimEntry(join(dir, 'missing'), 'a', 'file')).toThrow(/ENOENT/)
  })

  it('never hands the same name to two processes claiming at once', async () => {
    const module = fileURLToPath(new URL('../../common/claim-output.ts', import.meta.url))
    const script = `import { claimEntry } from ${JSON.stringify(module)}
for (let i = 0; i < 100; i++) console.log(claimEntry(process.argv[1], 'report.pdf', 'file'))`
    const claimers = Array.from({ length: 4 }, () =>
      run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dir])
    )

    const claimed = (await Promise.all(claimers)).flatMap(({ stdout }) => stdout.trim().split('\n'))

    expect(claimed).toHaveLength(400)
    expect(new Set(claimed).size).toBe(400)
    expect(await readdir(dir)).toHaveLength(400)
  }, 30_000)
})
