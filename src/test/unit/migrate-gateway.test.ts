import { afterEach, describe, expect, it, vi } from 'vitest'
import { categoryForFetchError, fetchCar, GatewayError } from '../../migrate/gateway.js'

// fetchCar is the only place migrate talks to a gateway. The error category
// it attaches is what the summary and the resume store key on, so each
// transport outcome must map to the right one and never leak a body.

const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'

function response(status: number, contentType: string | null, cancel = vi.fn(async () => undefined)): Response {
  const headers = new Headers()
  if (contentType != null) headers.set('content-type', contentType)
  return { ok: status >= 200 && status < 300, status, headers, body: { cancel } } as unknown as Response
}

describe('fetchCar', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the CAR body and the URL it requested', async () => {
    const res = response(200, 'application/vnd.ipld.car; version=1')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res)
    )

    const result = await fetchCar('https://gw.example/', CID)

    expect(result.url).toBe(
      `https://gw.example/ipfs/${CID}?format=car&dag-scope=all&car-version=1&car-order=dfs&car-dups=n`
    )
    expect(result.body).toBe(res.body)
  })

  it.each([
    [429, 'source_gateway_429'],
    [503, 'source_gateway_5xx'],
    [404, 'other'],
  ])('maps HTTP %i to %s and releases the body', async (status, category) => {
    const cancel = vi.fn(async () => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(status, 'application/vnd.ipld.car', cancel))
    )

    await expect(fetchCar('https://gw.example', CID)).rejects.toMatchObject({
      name: 'GatewayError',
      status,
      category,
    })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('rejects a gateway that answers with a file instead of a CAR', async () => {
    const cancel = vi.fn(async () => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(200, 'text/plain', cancel))
    )

    await expect(fetchCar('https://gw.example', CID)).rejects.toThrow(/not trustless/)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('wraps a transport failure with the category from its cause chain', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) })
      })
    )

    const err = await fetchCar('https://gw.example', CID).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(GatewayError)
    expect((err as GatewayError).category).toBe('source_gateway_timeout')
    expect((err as GatewayError).message).toContain('fetch failed')
  })
})

describe('categoryForFetchError', () => {
  it.each([
    ['AbortError by name', Object.assign(new Error('aborted'), { name: 'AbortError' }), 'source_gateway_timeout'],
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
