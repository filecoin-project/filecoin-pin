import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { privateUploadsByDefault, UPLOADS_ENV, writePrivateUploads } from '../../login/settings-file.js'

describe('settings file: private uploads by default', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'settings-'))
    path = join(dir, 'settings.env')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is off with no file and no variable', () => {
    expect(privateUploadsByDefault(path, {})).toBe(false)
  })

  it('is saved, and removed with the file once nothing else is in it', () => {
    writePrivateUploads(true, path)
    expect(readFileSync(path, 'utf8')).toBe('UPLOADS=private\n')
    expect(privateUploadsByDefault(path, {})).toBe(true)

    writePrivateUploads(false, path)
    expect(existsSync(path)).toBe(false)
    expect(privateUploadsByDefault(path, {})).toBe(false)
  })

  it("keeps the file's other entries", () => {
    writeFileSync(path, 'OTHER=kept\n')
    writePrivateUploads(true, path)
    writePrivateUploads(false, path)
    expect(readFileSync(path, 'utf8')).toBe('OTHER=kept\n')
  })

  it.each([
    ['private', false, true],
    ['public', true, false],
  ])('%s in the variable overrides the file', (value, file, expected) => {
    writePrivateUploads(file, path)
    expect(privateUploadsByDefault(path, { [UPLOADS_ENV]: value })).toBe(expected)
  })

  it('fails closed: an unknown value in the variable or the file is refused, not read as public', () => {
    expect(() => privateUploadsByDefault(path, { [UPLOADS_ENV]: 'yes' })).toThrow(
      `${UPLOADS_ENV} is "yes": use private or public`
    )
    writeFileSync(path, 'UPLOADS=Private\n')
    expect(() => privateUploadsByDefault(path, {})).toThrow(/UPLOADS in .* is "Private": use private or public/)
  })

  it('fails closed: a settings file that cannot be read is refused, naming the way out', () => {
    mkdirSync(path)
    expect(() => privateUploadsByDefault(path, {})).toThrow(/Cannot read .*settings\.env .*fix or remove it, or set/)
  })
})
