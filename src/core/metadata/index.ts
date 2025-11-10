export const ERC8004_TYPES = ['registration', 'validationrequest', 'validationresponse', 'feedback'] as const

export type ERC8004Type = (typeof ERC8004_TYPES)[number]

export interface MetadataConfigInput {
  metadata?: Record<string, string> | undefined
  dataSetMetadata?: Record<string, string> | undefined
  erc8004Type?: ERC8004Type
  erc8004Agent?: string
}

export interface MetadataConfigResult {
  metadata?: Record<string, string> | undefined
  dataSetMetadata?: Record<string, string> | undefined
}

export function normalizeMetadataConfig(input: MetadataConfigInput): MetadataConfigResult {
  const metadata = sanitizeRecord(input.metadata)
  const dataSetMetadata = sanitizeRecord(input.dataSetMetadata)

  if ((input.erc8004Type && !input.erc8004Agent) || (!input.erc8004Type && input.erc8004Agent)) {
    throw new Error('Both erc8004Type and erc8004Agent must be provided together')
  }

  if (input.erc8004Type && input.erc8004Agent) {
    const key = `8004${input.erc8004Type}`
    mergeRecord(metadata, key, input.erc8004Agent, 'ERC-8004 metadata', 'metadata')
    mergeRecord(dataSetMetadata, 'erc8004Files', '', 'ERC-8004 metadata', 'data set metadata')
  }

  return {
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    dataSetMetadata: Object.keys(dataSetMetadata).length > 0 ? dataSetMetadata : undefined,
  }
}

function sanitizeRecord(record: Record<string, string> | undefined): Record<string, string> {
  if (record == null) {
    return {}
  }

  const sanitized: Record<string, string> = {}

  for (const [rawKey, rawValue] of Object.entries(record)) {
    const key = rawKey.trim()
    if (key === '') {
      throw new Error('Metadata keys must be non-empty strings')
    }

    if (typeof rawValue !== 'string') {
      throw new Error(`Metadata value for "${key}" must be a string`)
    }

    sanitized[key] = rawValue
  }

  return sanitized
}

function mergeRecord(
  record: Record<string, string>,
  key: string,
  value: string,
  sourceLabel: string,
  conflictLabel: string
): void {
  const existingValue = record[key]
  if (existingValue != null && existingValue !== value) {
    throw new Error(
      `Conflicting metadata for "${key}": ${sourceLabel} tried to set "${value}" but ${conflictLabel} already set "${existingValue}".`
    )
  }

  record[key] = value
}
