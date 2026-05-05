export const ERC8004_TYPES = ['registration', 'validationrequest', 'validationresponse', 'feedback'] as const

export type ERC8004Type = (typeof ERC8004_TYPES)[number]

/**
 * Piece metadata key carrying the original file basename when a single
 * file is uploaded. Synapse SDK has no canonical key for this yet; if it
 * adopts one we will move to that constant.
 */
export const PIECE_METADATA_FILENAME_KEY = 'filename'

/**
 * Piece metadata key carrying the original directory name when a
 * directory is uploaded.
 */
export const PIECE_METADATA_DIRNAME_KEY = 'dirname'

export interface MetadataConfigInput {
  pieceMetadata?: Record<string, string> | undefined
  dataSetMetadata?: Record<string, string> | undefined
  erc8004Type?: ERC8004Type
  erc8004Agent?: string
}

export interface MetadataConfigResult {
  pieceMetadata?: Record<string, string> | undefined
  dataSetMetadata?: Record<string, string> | undefined
}

export function normalizeMetadataConfig(input: MetadataConfigInput): MetadataConfigResult {
  const pieceMetadata = sanitizeRecord(input.pieceMetadata)
  const dataSetMetadata = sanitizeRecord(input.dataSetMetadata)

  if ((input.erc8004Type && !input.erc8004Agent) || (!input.erc8004Type && input.erc8004Agent)) {
    throw new Error('Both erc8004Type and erc8004Agent must be provided together')
  }

  if (input.erc8004Type && input.erc8004Agent) {
    const key = `8004${input.erc8004Type}`
    mergeRecord(pieceMetadata, key, input.erc8004Agent, 'ERC-8004 metadata', 'metadata')
    mergeRecord(dataSetMetadata, 'erc8004Files', '', 'ERC-8004 metadata', 'data set metadata')
  }

  return {
    pieceMetadata: Object.keys(pieceMetadata).length > 0 ? pieceMetadata : undefined,
    dataSetMetadata: Object.keys(dataSetMetadata).length > 0 ? dataSetMetadata : undefined,
  }
}

/**
 * Merge a derived filename or directory name into existing piece metadata.
 *
 * User-supplied entries always win. If the user already set the same key
 * to a different value, the user value is preserved and the derived value
 * is dropped silently — this is auto-derived data, not a hard requirement.
 */
export function withDerivedNameMetadata(
  pieceMetadata: Record<string, string> | undefined,
  derived: { kind: 'file' | 'directory'; name: string }
): Record<string, string> | undefined {
  if (!derived.name) {
    return pieceMetadata
  }

  const key = derived.kind === 'directory' ? PIECE_METADATA_DIRNAME_KEY : PIECE_METADATA_FILENAME_KEY
  const existing = pieceMetadata?.[key]
  if (existing != null) {
    return pieceMetadata
  }

  return {
    ...(pieceMetadata ?? {}),
    [key]: derived.name,
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
