/**
 * Unit tests for the generic interactive terminal pager
 */

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type PagerPageResult, runPager } from '../../utils/cli-pager.js'

const ALT_SCREEN_EXIT = '\x1b[?1049l'
const BELL = '\x07'

class FakeInput extends EventEmitter {
  isTTY = true
  isRaw = false
  private paused = true

  setRawMode = vi.fn((mode: boolean) => {
    this.isRaw = mode
    return this
  })

  isPaused(): boolean {
    return this.paused
  }

  resume(): this {
    this.paused = false
    return this
  }

  pause(): this {
    this.paused = true
    return this
  }
}

class FakeOutput {
  isTTY = true
  writes: string[] = []

  write(chunk: string): boolean {
    this.writes.push(chunk)
    return true
  }
}

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function pressRight(input: FakeInput): void {
  input.emit('keypress', '\x1b[C', { name: 'right' })
}

function pressLeft(input: FakeInput): void {
  input.emit('keypress', '\x1b[D', { name: 'left' })
}

function pressQ(input: FakeInput): void {
  input.emit('keypress', 'q', { name: 'q' })
}

function pressCtrlC(input: FakeInput): void {
  input.emit('keypress', '\x03', { name: 'c', ctrl: true })
}

describe('runPager', () => {
  let input: FakeInput
  let output: FakeOutput

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function setup(firstPage: PagerPageResult<string>) {
    input = new FakeInput()
    output = new FakeOutput()
    const loadPage = vi.fn(
      async (pageIndex: number): Promise<PagerPageResult<string>> => ({
        page: `page${pageIndex}`,
        hasNext: pageIndex < 2,
      })
    )
    const renderPage = vi.fn(
      (page: string, pageIndex: number, options: { loading: boolean; loadingPageIndex?: number }) =>
        `${page}|${pageIndex}|${JSON.stringify(options)}`
    )
    const pagerPromise = runPager({
      firstPage,
      loadPage,
      renderPage,
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    })
    return { loadPage, renderPage, pagerPromise }
  }

  it('renders the first page immediately on start', async () => {
    const { renderPage, pagerPromise } = setup({ page: 'page0', hasNext: true })

    await vi.waitFor(() => expect(renderPage).toHaveBeenCalledWith('page0', 0, { loading: false }))

    pressQ(input)
    await pagerPromise
  })

  it('navigates right, loading the next page and re-rendering', async () => {
    const { loadPage, renderPage, pagerPromise } = setup({ page: 'page0', hasNext: true })
    await vi.waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1))

    pressRight(input)

    await vi.waitFor(() => expect(loadPage).toHaveBeenCalledWith(1))
    await vi.waitFor(() => expect(renderPage).toHaveBeenLastCalledWith('page1', 1, { loading: false }))

    pressQ(input)
    await pagerPromise
  })

  it('navigates left back to a previous page', async () => {
    const { loadPage, renderPage, pagerPromise } = setup({ page: 'page0', hasNext: true })
    pressRight(input)
    await vi.waitFor(() => expect(renderPage).toHaveBeenLastCalledWith('page1', 1, { loading: false }))

    pressLeft(input)

    await vi.waitFor(() => expect(loadPage).toHaveBeenCalledWith(0))
    await vi.waitFor(() => expect(renderPage).toHaveBeenLastCalledWith('page0', 0, { loading: false }))

    pressQ(input)
    await pagerPromise
  })

  it('left arrow at page 0 is a no-op that just rings the bell', async () => {
    const { loadPage, renderPage, pagerPromise } = setup({ page: 'page0', hasNext: true })
    await vi.waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1))

    pressLeft(input)
    await vi.waitFor(() => expect(output.writes).toContain(BELL))

    expect(loadPage).not.toHaveBeenCalled()

    pressQ(input)
    await pagerPromise
  })

  it('right arrow when hasNext is false is a no-op that just rings the bell', async () => {
    const { loadPage, renderPage, pagerPromise } = setup({ page: 'page0', hasNext: false })
    await vi.waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1))

    pressRight(input)
    await vi.waitFor(() => expect(output.writes).toContain(BELL))

    expect(loadPage).not.toHaveBeenCalled()

    pressQ(input)
    await pagerPromise
  })

  it('ignores navigation input while a page load is in flight, but Ctrl+C still aborts immediately', async () => {
    input = new FakeInput()
    output = new FakeOutput()
    const deferred = createDeferred<PagerPageResult<string>>()
    const loadPage = vi.fn(async (_pageIndex: number) => deferred.promise)
    const renderPage = vi.fn(
      (page: string, pageIndex: number, options: { loading: boolean; loadingPageIndex?: number }) =>
        `${page}|${pageIndex}|${JSON.stringify(options)}`
    )
    const pagerPromise = runPager({
      firstPage: { page: 'page0', hasNext: true },
      loadPage,
      renderPage,
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    })
    await vi.waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1))

    pressRight(input)
    await vi.waitFor(() => expect(loadPage).toHaveBeenCalledTimes(1))

    // A second navigation attempt while the first is still loading must be ignored.
    pressRight(input)
    pressLeft(input)
    await Promise.resolve()
    expect(loadPage).toHaveBeenCalledTimes(1)

    // Ctrl+C aborts immediately, without waiting for the in-flight load to resolve.
    pressCtrlC(input)
    await pagerPromise
    expect(output.writes).toContain(ALT_SCREEN_EXIT)

    deferred.resolve({ page: 'page1', hasNext: true })
  })

  it('quits on q and restores terminal state exactly once', async () => {
    const { pagerPromise } = setup({ page: 'page0', hasNext: true })
    await vi.waitFor(() => expect(input.setRawMode).toHaveBeenCalledWith(true))

    pressQ(input)
    await pagerPromise

    expect(output.writes).toContain(ALT_SCREEN_EXIT)
    expect(input.setRawMode).toHaveBeenLastCalledWith(false)
    // Once for entering raw mode, once for restoring it on cleanup.
    expect(input.setRawMode).toHaveBeenCalledTimes(2)
  })

  it('rejects the pager promise when loadPage fails, still cleaning up the terminal', async () => {
    input = new FakeInput()
    output = new FakeOutput()
    const loadPage = vi.fn(async (pageIndex: number) => {
      if (pageIndex === 1) {
        throw new Error('boom')
      }
      return { page: `page${pageIndex}`, hasNext: true }
    })
    const renderPage = vi.fn((page: string, pageIndex: number) => `${page}|${pageIndex}`)
    const pagerPromise = runPager({
      firstPage: { page: 'page0', hasNext: true },
      loadPage,
      renderPage,
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    })
    await vi.waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1))

    pressRight(input)

    await expect(pagerPromise).rejects.toThrow('boom')
    expect(output.writes).toContain(ALT_SCREEN_EXIT)
  })

  it('SIGINT resolves the pager and restores terminal state', async () => {
    const { pagerPromise } = setup({ page: 'page0', hasNext: true })
    await vi.waitFor(() => expect(input.setRawMode).toHaveBeenCalledWith(true))

    process.emit('SIGINT')

    await pagerPromise
    expect(output.writes).toContain(ALT_SCREEN_EXIT)
  })

  it('shows the target page while loading, even when navigating backward', async () => {
    input = new FakeInput()
    output = new FakeOutput()
    const deferred = createDeferred<PagerPageResult<string>>()
    let callCount = 0
    const loadPage = vi.fn(async (pageIndex: number): Promise<PagerPageResult<string>> => {
      callCount++
      // The third navigation (right, right, then this left) hangs until resolved below.
      if (callCount === 3) {
        return deferred.promise
      }
      return { page: `page${pageIndex}`, hasNext: pageIndex < 2 }
    })
    const renderPage = vi.fn(
      (page: string, pageIndex: number, options: { loading: boolean; loadingPageIndex?: number }) =>
        `${page}|${pageIndex}|${JSON.stringify(options)}`
    )
    const pagerPromise = runPager({
      firstPage: { page: 'page0', hasNext: true },
      loadPage,
      renderPage,
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    })
    await vi.waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1))

    pressRight(input)
    await vi.waitFor(() => expect(renderPage).toHaveBeenLastCalledWith('page1', 1, { loading: false }))
    pressRight(input)
    await vi.waitFor(() => expect(renderPage).toHaveBeenLastCalledWith('page2', 2, { loading: false }))

    pressLeft(input)
    await vi.waitFor(() =>
      expect(renderPage).toHaveBeenLastCalledWith('page2', 2, { loading: true, loadingPageIndex: 1 })
    )

    deferred.resolve({ page: 'page1', hasNext: true })
    await vi.waitFor(() => expect(renderPage).toHaveBeenLastCalledWith('page1', 1, { loading: false }))

    pressQ(input)
    await pagerPromise
  })
})
