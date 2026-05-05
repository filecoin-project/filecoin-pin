import { mainnet } from '@filoz/synapse-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseCLIAuth, parseContextSelectionOptions } from '../../utils/cli-auth.js'

const testPrivateKey = '0x0000000000000000000000000000000000000000000000000000000000000001'

describe('parseContextSelectionOptions empty-list regression', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.PROVIDER_IDS
    delete process.env.DATA_SET_IDS
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  // Without this guard, callers in src/add/add.ts and src/import/import.ts set
  // autoFundOptions.copies = providerIds.length, which would silently become 0.
  it('throws on a comma-only provider list rather than returning []', () => {
    expect(() => parseContextSelectionOptions({ providerIds: ',' })).toThrow(/Invalid provider ID/)
  })

  it('throws on a comma-only data set list rather than returning []', () => {
    expect(() => parseContextSelectionOptions({ dataSetIds: ',,' })).toThrow(/Invalid data set ID/)
  })
})

describe('parseCLIAuth network defaults', () => {
  it('uses mainnet chain and RPC URL when no network is provided', () => {
    const config = parseCLIAuth({ privateKey: testPrivateKey })
    const expectedRpcUrl = mainnet.rpcUrls.default.webSocket?.[0] ?? mainnet.rpcUrls.default.http[0]

    expect(config.chain?.id).toBe(mainnet.id)
    expect(config.rpcUrl).toBe(expectedRpcUrl)
  })

  it('keeps the mainnet chain when only a custom RPC URL is provided', () => {
    const config = parseCLIAuth({
      privateKey: testPrivateKey,
      rpcUrl: 'wss://custom.rpc.url/ws',
    })

    expect(config.chain?.id).toBe(mainnet.id)
    expect(config.rpcUrl).toBe('wss://custom.rpc.url/ws')
  })
})
