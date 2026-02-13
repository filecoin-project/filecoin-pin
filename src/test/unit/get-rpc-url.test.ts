import { describe, expect, it } from 'vitest'
import { getRpcUrl, RPC_URLS } from '../../common/get-rpc-url.js'
import type { CLIAuthOptions } from '../../utils/cli-auth.js'

/**
 * In production Commander already maps env vars (NETWORK/RPC_URL) into CLI options.
 * These tests cover the behavior of getRpcUrl given the options object Commander
 * would pass, without interacting with process.env directly.
 */

describe('getRpcUrl', () => {
  it('returns explicit rpcUrl even when network is provided', () => {
    const options: CLIAuthOptions = {
      rpcUrl: 'wss://custom.rpc.url/ws',
      network: 'mainnet',
    }

    expect(getRpcUrl(options)).toBe('wss://custom.rpc.url/ws')
  })

  it.each([
    ['mainnet', RPC_URLS.mainnet.webSocket],
    ['calibration', RPC_URLS.calibration.webSocket],
  ])('returns RPC URL for %s network', (network, expected) => {
    expect(getRpcUrl({ network } satisfies CLIAuthOptions)).toBe(expected)
  })

  it('normalizes network casing and whitespace', () => {
    expect(
      getRpcUrl({
        network: '  MAINNET  ',
      })
    ).toBe(RPC_URLS.mainnet.webSocket)

    expect(
      getRpcUrl({
        network: '\tCaLiBrAtIoN\n',
      })
    ).toBe(RPC_URLS.calibration.webSocket)
  })

  it('defaults to calibration when network is missing or blank', () => {
    expect(getRpcUrl({})).toBe(RPC_URLS.calibration.webSocket)
    expect(getRpcUrl({ network: '' })).toBe(RPC_URLS.calibration.webSocket)
    expect(getRpcUrl({ network: '   ' })).toBe(RPC_URLS.calibration.webSocket)
  })

  it('treats empty rpcUrl as falsy and falls back to defaults', () => {
    expect(getRpcUrl({ rpcUrl: '' })).toBe(RPC_URLS.calibration.webSocket)
  })

  it('throws for unsupported networks', () => {
    expect(() => getRpcUrl({ network: 'invalid' })).toThrow(
      'Invalid network: "invalid". Must be "mainnet" or "calibration"'
    )
  })
})
