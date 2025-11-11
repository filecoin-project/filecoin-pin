import { type Command, Option } from 'commander'
import { ERC8004_TYPES, normalizeMetadataConfig } from '../core/metadata/index.js'

function collectKeyValue(value: string, previous: string[] = []): string[] {
  const entries = previous ?? []
  entries.push(value)
  return entries
}

function parseKeyValuePairs(pairs: string[], flagLabel: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const pair of pairs) {
    const delimiterIndex = pair.indexOf('=')
    if (delimiterIndex === -1) {
      throw new Error(`${flagLabel} entries must use key=value format (received "${pair}")`)
    }
    const key = pair.slice(0, delimiterIndex).trim()
    const value = pair.slice(delimiterIndex + 1)

    if (key === '') {
      throw new Error(`${flagLabel} entries require a non-empty key (received "${pair}")`)
    }

    result[key] = value
  }
  return result
}

export interface MetadataOptionConfig {
  includePieceMetadata?: boolean
  includeDataSetMetadata?: boolean
  includeErc8004?: boolean
}

/**
 * Registers metadata-related Commander flags on a CLI command.
 * Adds piece-level metadata flags by default, dataset metadata flags (with alias support),
 * and optionally ERC-8004 artifact options depending on the provided configuration.
 *
 * @param command Commander command to augment (mutated in place)
 * @param config Controls which categories of metadata flags should be attached
 * @returns The same command instance to support fluent configuration
 */
export function addMetadataOptions(command: Command, config: MetadataOptionConfig = {}): Command {
  const includePieceMetadata = config.includePieceMetadata ?? true
  const includeDataSetMetadata = config.includeDataSetMetadata ?? true
  const includeErc8004 = config.includeErc8004 ?? false

  if (includePieceMetadata) {
    command.option(
      '--metadata <key=value>',
      'Add piece metadata entry (repeatable; value may be empty)',
      collectKeyValue,
      []
    )
  }

  if (includeDataSetMetadata) {
    const dataSetOption = new Option(
      '--data-set-metadata <key=value>',
      'Add data set metadata entry (repeatable; value may be empty)'
    )
      .argParser(collectKeyValue)
      .default([])
    const aliasOption = new Option('--dataset-metadata <key=value>').argParser(collectKeyValue).default([]).hideHelp()
    command.addOption(dataSetOption)
    command.addOption(aliasOption)
  }

  if (includeErc8004) {
    const typeOption = new Option('--8004-type <type>', 'ERC-8004 artifact type').choices(
      ERC8004_TYPES as readonly string[]
    )
    command.addOption(typeOption)
    command.option('--8004-agent <id>', 'ERC-8004 agent identifier (DID, address, etc.)')
  }

  return command
}

export interface MetadataResolutionConfig {
  includeErc8004?: boolean
}

export interface ResolvedMetadataOptions {
  metadata?: Record<string, string>
  dataSetMetadata?: Record<string, string>
}

/**
 * Converts Commander option values into normalized metadata objects used by upload flows.
 * Aggregates `--metadata` and `--data-set-metadata` flags (including aliases), then applies
 * `normalizeMetadataConfig` to ensure optional ERC-8004 fields are propagated when requested.
 *
 * @param options Parsed Commander options, typically the result of `command.opts()`
 * @param config Controls whether ERC-8004 parameters should be included in the normalization step
 * @returns Metadata maps ready to pass into upload APIs, excluding keys that were not provided
 */
export function resolveMetadataOptions(
  options: Record<string, any>,
  config: MetadataResolutionConfig = {}
): ResolvedMetadataOptions {
  const metadataPairs = Array.isArray(options.metadata) ? options.metadata : []
  const dsMetadataPairs = [
    ...(Array.isArray(options.dataSetMetadata) ? options.dataSetMetadata : []),
    ...(Array.isArray(options.datasetMetadata) ? options.datasetMetadata : []),
  ]

  const parsedMetadata = parseKeyValuePairs(metadataPairs, '--metadata')
  const parsedDataSetMetadata = parseKeyValuePairs(dsMetadataPairs, '--data-set-metadata')

  const { metadata, dataSetMetadata } = normalizeMetadataConfig({
    metadata: Object.keys(parsedMetadata).length > 0 ? parsedMetadata : undefined,
    dataSetMetadata: Object.keys(parsedDataSetMetadata).length > 0 ? parsedDataSetMetadata : undefined,
    erc8004Type: config.includeErc8004 ? options['8004Type'] : undefined,
    erc8004Agent: config.includeErc8004 ? options['8004Agent'] : undefined,
  })

  const resolved: ResolvedMetadataOptions = {}
  if (metadata) {
    resolved.metadata = metadata
  }
  if (dataSetMetadata) {
    resolved.dataSetMetadata = dataSetMetadata
  }
  return resolved
}
