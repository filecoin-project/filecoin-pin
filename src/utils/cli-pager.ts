/**
 * Generic interactive terminal pager
 *
 * Drives a left/right/q-navigable, alt-screen TUI over pages of caller-defined
 * shape. Knows nothing about the data being paged - callers supply a page
 * loader and a renderer. Reusable by any future list-style command.
 *
 * @module utils/cli-pager
 */

import { emitKeypressEvents, type Key } from 'node:readline'

const ALT_SCREEN_ENTER = '\x1b[?1049h\x1b[H'
const ALT_SCREEN_EXIT = '\x1b[?1049l'
const CLEAR_SCREEN = '\x1b[2J\x1b[H'
const BELL = '\x07'

type PagerInput = NodeJS.ReadStream & {
  isRaw?: boolean
  setRawMode?: (mode: boolean) => NodeJS.ReadStream
}

/** Result of loading a single page. */
export interface PagerPageResult<TPage> {
  /** Caller-defined page payload to render */
  page: TPage
  /** Whether a page after this one is available */
  hasNext: boolean
}

export interface RunPagerOptions<TPage> {
  /** The already-loaded first page (loaded by the caller before entering the alt screen) */
  firstPage: PagerPageResult<TPage>
  /** Load the page at `pageIndex` (0-based) */
  loadPage: (pageIndex: number) => Promise<PagerPageResult<TPage>>
  /**
   * Render a page to a string for display. `loading` is true while a
   * navigation request is in flight (the previous page's data is passed so
   * the screen has something to show while it loads). `loadingPageIndex` is
   * the page being navigated to, which may differ from `pageIndex` (the
   * currently displayed page) while loading.
   */
  renderPage: (page: TPage, pageIndex: number, options: { loading: boolean; loadingPageIndex?: number }) => string
  input?: NodeJS.ReadStream
  output?: NodeJS.WriteStream
}

/**
 * Run an interactive pager until the user quits, interrupts, or an error occurs.
 *
 * Owns the alt-screen buffer, raw-mode keypress handling, and terminal cleanup.
 * Left/right arrows navigate pages, `q` quits, Ctrl+C always aborts immediately
 * (even mid-load). All other input is ignored while a page is loading.
 */
export async function runPager<TPage>(options: RunPagerOptions<TPage>): Promise<void> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout

  if (input.isTTY !== true || output.isTTY !== true) {
    throw new Error('Interactive pager requires TTY input and output')
  }
  const rawInput: PagerInput = input
  if (rawInput.setRawMode == null) {
    throw new Error('Interactive pager requires a stream that supports raw mode')
  }

  let pageIndex = 0
  let current = options.firstPage
  let isLoading = false
  let isFinished = false
  let cleanedUp = false
  let resolvePager: (() => void) | undefined
  let rejectPager: ((error: unknown) => void) | undefined

  const wasRawMode = rawInput.isRaw === true
  const wasPaused = input.isPaused()

  const cleanup = (): void => {
    if (cleanedUp) {
      return
    }
    cleanedUp = true
    input.off('keypress', onKeypress)
    process.off('SIGINT', onExit)
    process.off('SIGHUP', onExit)
    rawInput.setRawMode?.(wasRawMode)
    if (wasPaused) {
      input.pause()
    }
    output.write(ALT_SCREEN_EXIT)
  }

  const finish = (): void => {
    isFinished = true
    cleanup()
    resolvePager?.()
  }

  const fail = (error: unknown): void => {
    isFinished = true
    cleanup()
    rejectPager?.(error)
  }

  const onExit = (): void => {
    finish()
  }

  const draw = (loading: boolean, loadingPageIndex?: number): void => {
    output.write(CLEAR_SCREEN)
    output.write(
      options.renderPage(
        current.page,
        pageIndex,
        loadingPageIndex == null ? { loading } : { loading, loadingPageIndex }
      )
    )
  }

  const goToPage = async (nextPageIndex: number): Promise<void> => {
    if (isLoading) {
      return
    }
    isLoading = true
    draw(true, nextPageIndex)
    try {
      const result = await options.loadPage(nextPageIndex)
      if (isFinished) {
        return
      }
      pageIndex = nextPageIndex
      current = result
      draw(false)
    } catch (error) {
      fail(error)
    } finally {
      isLoading = false
    }
  }

  const onKeypress = (sequence: string, key: Key): void => {
    if (key.ctrl === true && key.name === 'c') {
      finish()
      return
    }
    if (isLoading) {
      return
    }
    if (sequence === 'q' || key.name === 'q') {
      finish()
      return
    }
    if (isLeftArrow(sequence, key)) {
      if (pageIndex === 0) {
        output.write(BELL)
        return
      }
      void goToPage(pageIndex - 1)
      return
    }
    if (isRightArrow(sequence, key)) {
      if (!current.hasNext) {
        output.write(BELL)
        return
      }
      void goToPage(pageIndex + 1)
    }
  }

  try {
    output.write(ALT_SCREEN_ENTER)
    draw(false)
    emitKeypressEvents(input)
    rawInput.setRawMode(true)
    input.resume()
    input.on('keypress', onKeypress)
    process.once('SIGINT', onExit)
    process.once('SIGHUP', onExit)

    await new Promise<void>((resolve, reject) => {
      resolvePager = resolve
      rejectPager = reject
    })
  } finally {
    cleanup()
  }
}

function isLeftArrow(sequence: string, key: Key): boolean {
  return key.name === 'left' || sequence === '\x1b[D' || sequence === '\x1bOD'
}

function isRightArrow(sequence: string, key: Key): boolean {
  return key.name === 'right' || sequence === '\x1b[C' || sequence === '\x1bOC'
}
