import { afterEach, describe, expect, it, vi } from 'vitest'
import { CAR_ACCEPT } from '../../migrate/car-url.js'
import { categoryForFetchError, fetchCar, rootCause, StagingError } from '../../migrate/gateway.js'

// fetchCar is the only place migrate talks to a gateway. The error category
// it attaches is what the summary and the resume store key on, so each
// transport outcome must map to the right one and never leak a body.

const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'

function response(
  status: number,
  contentType: string | null,
  body: { cancel: () => Promise<void> } | null = { cancel: vi.fn(async () => undefined) }
): Response {
  const headers = new Headers()
  if (contentType != null) headers.set('content-type', contentType)
  return { ok: status >= 200 && status < 300, status, headers, body } as unknown as Response
}

describe('fetchCar', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requests the CAR with the trustless accept header and returns the body', async () => {
    const res = response(200, 'application/vnd.ipld.car; version=1')
    const fetch = vi.fn(async () => res)
    vi.stubGlobal('fetch', fetch)

    const result = await fetchCar('https://gw.example/', CID)

    const url = `https://gw.example/ipfs/${CID}?format=car&dag-scope=all&car-version=1&car-order=dfs&car-dups=n`
    expect(fetch).toHaveBeenCalledWith(url, { headers: { accept: CAR_ACCEPT } })
    expect(result).toEqual({ url, body: res.body })
  })

  it.each([
    [429, 'source_gateway_429'],
    [404, 'source_not_found'],
    [410, 'source_not_found'],
    [500, 'source_gateway_5xx'],
    [503, 'source_gateway_5xx'],
    [599, 'source_gateway_5xx'],
    [499, 'other'],
    [600, 'other'],
  ])('maps HTTP %i to %s and releases the body', async (status, category) => {
    const cancel = vi.fn(async () => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(status, 'application/vnd.ipld.car', { cancel }))
    )

    await expect(fetchCar('https://gw.example', CID)).rejects.toMatchObject({
      name: 'StagingError',
      category,
      message: expect.stringContaining(`HTTP ${status}`),
    })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('rejects a gateway that answers with a file instead of a CAR', async () => {
    const cancel = vi.fn(async () => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(200, 'text/plain', { cancel }))
    )

    await expect(fetchCar('https://gw.example', CID)).rejects.toMatchObject({
      name: 'StagingError',
      category: 'other',
      message: expect.stringMatching(/not trustless/),
    })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('rejects an empty body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(200, 'application/vnd.ipld.car', null))
    )

    await expect(fetchCar('https://gw.example', CID)).rejects.toMatchObject({
      name: 'StagingError',
      category: 'other',
    })
  })

  it('wraps a transport failure with the category and the reason from its cause chain', async () => {
    const cause = Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' })
    const outer = new TypeError('fetch failed', { cause })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw outer
      })
    )

    const err = await fetchCar('https://gw.example', CID).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(StagingError)
    expect(err).toMatchObject({ category: 'source_gateway_timeout', cause: outer })
    expect((err as Error).message).toContain('ETIMEDOUT')
  })
})

describe('categoryForFetchError', () => {
  it.each([
    ['TimeoutError by name', Object.assign(new Error('timed out'), { name: 'TimeoutError' }), 'source_gateway_timeout'],
    [
      'AbortError is a cancel, not a timeout',
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
      'source_gateway_network',
    ],
    [
      'undici timeout code',
      Object.assign(new Error('x'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
      'source_gateway_timeout',
    ],
    [
      'timeout two causes deep',
      new Error('outer', { cause: new Error('mid', { cause: Object.assign(new Error('in'), { code: 'ETIMEDOUT' }) }) }),
      'source_gateway_timeout',
    ],
    ['connection refused', Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), 'source_gateway_network'],
    ['unknown error', new Error('whatever'), 'source_gateway_network'],
    ['non-error value', 'string', 'source_gateway_network'],
  ])('%s -> %s', (_label, err, category) => {
    expect(categoryForFetchError(err)).toBe(category)
  })

  it('stops on a cause cycle', () => {
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    ;(a as { cause?: unknown }).cause = b
    expect(categoryForFetchError(a)).toBe('source_gateway_network')
  })
})

describe('rootCause', () => {
  it.each([
    [
      'the innermost code',
      new Error('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) }),
      'ENOTFOUND',
    ],
    ['the innermost message without a code', new Error('outer', { cause: new Error('inner') }), 'inner'],
    ['a bare error', new Error('alone'), 'alone'],
    ['a non-error', 42, '42'],
  ])('reports %s', (_label, err, expected) => {
    expect(rootCause(err)).toBe(expected)
  })
})
