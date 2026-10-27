/**
 * Claim a fresh entry name inside an output directory the way Chrome saves a download, without
 * the space: `report.pdf`, then `report(1).pdf`, `report(2).pdf`, ... The number goes before
 * the last extension, except that a compression suffix stays with a short extension before it
 * (`archive.tar.gz` -> `archive(1).tar.gz`). Dots inside the name are kept
 * (`report.v2.pdf` -> `report.v2(1).pdf`). A name with no extension, a dotfile
 * (`.env` -> `.env(1)`) and a folder (`photos(1)`) get the number at the end.
 *
 * Every attempt is an exclusive create (`mkdir`, or `open` with `wx`), so two writers can
 * never get the same name. The create is synchronous on purpose: a signal handler can only
 * run once the call returns, so the caller always knows what it claimed before the handler can
 * need it.
 */

import { closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'

export type EntryKind = 'file' | 'folder'

/** Suffixes that belong with the extension before them, as in `.tar.gz`. */
const COMPRESSION_SUFFIXES = new Set(['bz', 'bz2', 'gz', 'lz', 'lzma', 'xz', 'z', 'zst'])

/** A short extension that can carry a compression suffix: `tar` in `.tar.gz`, `csv` in `.csv.gz`. */
const SHORT_EXTENSION = /^[a-z0-9]{1,4}$/i

/** Where the extension of a file name starts, or -1 when it has none (dotfiles included). */
function extensionStart(name: string): number {
  const last = name.lastIndexOf('.')
  if (last <= 0) {
    return -1
  }
  if (!COMPRESSION_SUFFIXES.has(name.slice(last + 1).toLowerCase())) {
    return last
  }
  const previous = name.lastIndexOf('.', last - 1)
  return previous > 0 && SHORT_EXTENSION.test(name.slice(previous + 1, last)) ? previous : last
}

/** `name` with `(n)` inserted as Chrome would, without the space; `n = 0` is the name itself. */
export function numberedName(name: string, n: number, kind: EntryKind): string {
  if (n === 0) {
    return name
  }
  const dot = kind === 'file' ? extensionStart(name) : -1
  if (dot === -1) {
    return `${name}(${n})`
  }
  return `${name.slice(0, dot)}(${n})${name.slice(dot)}`
}

/**
 * Create `name` (or the first free numbered variant) in `dir` and return its path. A file is
 * created empty with mode 0600, a folder with mode 0700.
 */
export function claimEntry(dir: string, name: string, kind: EntryKind): string {
  // Ends: each EEXIST means one more name is already taken in `dir`.
  for (let n = 0; ; n++) {
    const path = join(dir, numberedName(name, n, kind))
    try {
      if (kind === 'folder') {
        mkdirSync(path, { mode: 0o700 })
      } else {
        closeSync(openSync(path, 'wx', 0o600))
      }
      return path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }
  }
}
