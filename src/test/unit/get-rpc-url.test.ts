import { calibration, mainnet } from '@filoz/synapse-sdk'
import { describe, expect, it } from 'vitest'
import { DEFAULT_NETWORK, getRpcUrl } from '../../common/get-rpc-url.js'
import type { CLIAuthOptions } from '../../utils/cli-auth.js'

// Extract expected WebSocket URLs from chain definitions
const mainnetWsUrl = mainnet.rpcUrls.default.webSocket?.[0] ?? mainnet.rpcUrls.default.http[0]
const calibrationWsUrl = calibration.rpcUrls.default.webSocket?.[0] ?? calibration.rpcUrls.default.http[0]

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
    ['mainnet', mainnetWsUrl],
    ['calibration', calibrationWsUrl],
  ])('returns RPC URL for %s network', (network, expected) => {
    expect(getRpcUrl({ network } satisfies CLIAuthOptions)).toBe(expected)
  })

  it('normalizes network casing and whitespace', () => {
    expect(
      getRpcUrl({
        network: '  MAINNET  ',
      })
    ).toBe(mainnetWsUrl)

    expect(
      getRpcUrl({
        network: '\tCaLiBrAtIoN\n',
      })
    ).toBe(calibrationWsUrl)
  })

  it('defaults to mainnet when network is missing or blank', () => {
    expect(DEFAULT_NETWORK).toBe('mainnet')
    expect(getRpcUrl({})).toBe(mainnetWsUrl)
    expect(getRpcUrl({ network: '' })).toBe(mainnetWsUrl)
    expect(getRpcUrl({ network: '   ' })).toBe(mainnetWsUrl)
  })

  it('treats empty rpcUrl as falsy and falls back to defaults', () => {
    expect(getRpcUrl({ rpcUrl: '' })).toBe(mainnetWsUrl)
  })

  it('throws for unsupported networks', () => {
    expect(() => getRpcUrl({ network: 'invalid' })).toThrow(
      'Invalid network: "invalid". Must be "mainnet", "calibration", or "devnet"'
    )
  })
})
