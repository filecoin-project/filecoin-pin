import { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { addMetadataOptions, resolveMetadataOptions } from '../../utils/cli-options-metadata.js'

function parse(args: string[]) {
  const command = addMetadataOptions(new Command(), { includeErc8004: true }).exitOverride()
  command.parse(args, { from: 'user' })
  return resolveMetadataOptions(command.opts(), { includeErc8004: true })
}

describe('addMetadataOptions ERC-8004 flags', () => {
  it('resolves the canonical --erc8004-type/--erc8004-agent flags', () => {
    const resolved = parse(['--erc8004-type', 'registration', '--erc8004-agent', 'did:key:z1'])
    expect(resolved.pieceMetadata).toMatchObject({ '8004registration': 'did:key:z1' })
  })

  it('still accepts the deprecated --8004-type/--8004-agent aliases', () => {
    const resolved = parse(['--8004-type', 'feedback', '--8004-agent', 'did:key:z2'])
    expect(resolved.pieceMetadata).toMatchObject({ '8004feedback': 'did:key:z2' })
  })

  it('prefers canonical flags when both canonical and legacy aliases are provided', () => {
    const resolved = parse([
      '--erc8004-type',
      'registration',
      '--erc8004-agent',
      'did:key:canonical',
      '--8004-type',
      'feedback',
      '--8004-agent',
      'did:key:legacy',
    ])
    expect(resolved.pieceMetadata).toEqual({ '8004registration': 'did:key:canonical' })
  })

  it('does not advertise the deprecated --8004 aliases in --help output', () => {
    const command = addMetadataOptions(new Command(), { includeErc8004: true }).exitOverride()
    const help = command.helpInformation()
    expect(help).toContain('--erc8004-type')
    expect(help).toContain('--erc8004-agent')
    expect(help).not.toContain('--8004-type')
    expect(help).not.toContain('--8004-agent')
  })
})
