import { afterAll, beforeAll, vi } from 'vitest'

beforeAll(() => {
  // Force Number#toLocaleString to behave like en-US everywhere
  vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (
    this: number,
    _locales?: Intl.LocalesArgument,
    options?: Intl.NumberFormatOptions
  ): string {
    // Recreate the formatter per call so options still work
    const fmt = new Intl.NumberFormat('en-US', options)

    return fmt.format(Number(this.valueOf()))
  })
})

afterAll(() => {
  vi.restoreAllMocks()
})
