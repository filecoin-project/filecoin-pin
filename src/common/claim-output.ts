/**
 * Claim a fresh entry name inside an output directory the way a browser saves a download:
 * `report.pdf`, then `report (1).pdf`, `report (2).pdf`, ... The number goes before the
 * last extension (`archive.tar.gz` -> `archive.tar (1).gz`); a name with no extension, a
 * dotfile (`.env` -> `.env (1)`) and a folder (`photos (1)`) get it at the end.
 *
 * Every attempt is an exclusive create (`mkdir`, or `open` with `wx`), so two writers can
 * never get the same name. The create is synchronous on purpose: a signal handler can only
 * run once the call returns, so the caller always knows what it claimed before the handler can
 * need it.
 */

import { closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'

export type EntryKind = 'file' | 'folder'

const MAX_ATTEMPTS = 1000

/** Every numbered name was taken. The message names no entry, so it is safe to print. */
export class NoFreeNameError extends Error {
  constructor() {
    super(`No free name in the output directory after ${MAX_ATTEMPTS} numbered attempts`)
    this.name = 'NoFreeNameError'
  }
}

/** `name` with ` (n)` inserted as a browser would; `n = 0` is the name itself. */
export function numberedName(name: string, n: number, kind: EntryKind): string {
  if (n === 0) {
    return name
  }
  const dot = kind === 'file' ? name.lastIndexOf('.') : -1
  if (dot <= 0) {
    return `${name} (${n})`
  }
  return `${name.slice(0, dot)} (${n})${name.slice(dot)}`
}

/**
 * Create `name` (or the first free numbered variant) in `dir` and return its path. A file is
 * created empty with mode 0600, a folder with mode 0700.
 */
export function claimEntry(dir: string, name: string, kind: EntryKind): string {
  for (let n = 0; n < MAX_ATTEMPTS; n++) {
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
  throw new NoFreeNameError()
}
