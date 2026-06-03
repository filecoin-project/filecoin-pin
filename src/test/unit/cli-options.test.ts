import { Command, Option } from 'commander'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addDataSetIdOption,
  addNetworkOptions,
  addProviderIdOption,
  validateAndNormalizeAutoFundOptions,
} from '../../utils/cli-options.js'

describe('ID flag attribute merging', () => {
  it('merges --provider-id and the deprecated --provider-ids into providerIds', () => {
    const command = addProviderIdOption(new Command()).exitOverride()
    command.parse(['--provider-id', '7', '--provider-ids', '1,2', '--provider-id', '9'], { from: 'user' })
    const opts = command.opts()
    expect(opts.providerIds).toEqual(['7', '1,2', '9'])
    expect(opts).not.toHaveProperty('providerIdsCsv')
  })

  it('merges --data-set-id and the deprecated --data-set-ids into dataSetIds', () => {
    const command = addDataSetIdOption(new Command(), { includeSingleAlias: true }).exitOverride()
    command.parse(['--data-set-id', '3', '--data-set-ids', '4,5'], { from: 'user' })
    const opts = command.opts()
    expect(opts.dataSetIds).toEqual(['3', '4,5'])
    expect(opts).not.toHaveProperty('dataSetIdsCsv')
  })
})

describe('addNetworkOptions', () => {
  const originalNetwork = process.env.NETWORK

  beforeEach(() => {
    delete process.env.NETWORK
  })

  afterEach(() => {
    if (originalNetwork === undefined) delete process.env.NETWORK
    else process.env.NETWORK = originalNetwork
  })

  it('leaves --network unset when neither flag nor env is provided', () => {
    const command = addNetworkOptions(new Command()).exitOverride()
    command.parse([], { from: 'user' })
    expect(command.opts().network).toBeUndefined()
  })

  it('reads --network from the NETWORK env var', () => {
    process.env.NETWORK = 'calibration'
    const command = addNetworkOptions(new Command()).exitOverride()
    command.parse([], { from: 'user' })
    expect(command.opts().network).toBe('calibration')
  })

  it('errors when --network and --rpc-url are both provided', () => {
    const command = addNetworkOptions(new Command()).exitOverride()
    command.addOption(new Option('--rpc-url <url>').env('RPC_URL'))
    expect(() =>
      command.parse(['--network', 'mainnet', '--rpc-url', 'wss://example.test/rpc'], { from: 'user' })
    ).toThrow(/cannot be used with option/)
  })

  it('errors when NETWORK and RPC_URL env vars are both set', () => {
    process.env.NETWORK = 'mainnet'
    process.env.RPC_URL = 'wss://example.test/rpc'
    const command = addNetworkOptions(new Command()).exitOverride()
    command.addOption(new Option('--rpc-url <url>').env('RPC_URL'))
    expect(() => command.parse([], { from: 'user' })).toThrow(/cannot be used with/)
    delete process.env.RPC_URL
  })

  it('accepts --network calibnet and normalizes to calibration', () => {
    const command = addNetworkOptions(new Command()).exitOverride()
    command.parse(['--network', 'calibnet'], { from: 'user' })
    expect(command.opts().network).toBe('calibration')
  })

  it('accepts NETWORK=calibnet env var and normalizes to calibration', () => {
    process.env.NETWORK = 'calibnet'
    try {
      const command = addNetworkOptions(new Command()).exitOverride()
      command.parse([], { from: 'user' })
      expect(command.opts().network).toBe('calibration')
    } finally {
      delete process.env.NETWORK
    }
  })

  it('does not advertise the calibnet alias in --help output', () => {
    const command = addNetworkOptions(new Command()).exitOverride()
    const help = command.helpInformation()
    expect(help).toContain('mainnet')
    expect(help).toContain('calibration')
    expect(help).toContain('devnet')
    expect(help).not.toContain('calibnet')
  })
})

describe('validateAndNormalizeAutoFundOptions', () => {
  it('throws when --min-runway-days is set without --auto-fund', () => {
    expect(() => validateAndNormalizeAutoFundOptions({ minRunwayDays: 10 })).toThrow(
      '--min-runway-days requires --auto-fund'
    )
  })

  it('throws when --max-balance is set without --auto-fund', () => {
    expect(() => validateAndNormalizeAutoFundOptions({ maxBalance: '5.0' })).toThrow(
      '--max-balance requires --auto-fund'
    )
  })

  it('parses both modifiers when --auto-fund is set', () => {
    const result = validateAndNormalizeAutoFundOptions({
      autoFund: true,
      minRunwayDays: 365,
      maxBalance: '5.0',
    })
    expect(result.autoFund).toBe(true)
    expect(result.minRunwayDays).toBe(365)
    expect(result.maxBalance).toBe(5_000_000_000_000_000_000n) // 5 USDFC at 18 decimals
  })

  it('rejects non-positive --min-runway-days', () => {
    expect(() => validateAndNormalizeAutoFundOptions({ autoFund: true, minRunwayDays: 0 })).toThrow(
      /--min-runway-days must be a positive integer/
    )
  })
})
