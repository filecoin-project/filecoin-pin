export const ERC8004_TYPES = ['registration', 'validationrequest', 'validationresponse', 'feedback'] as const

export type ERC8004Type = (typeof ERC8004_TYPES)[number]

/**
 * Piece metadata key carrying the original basename of the source path
 * (file basename for single-file uploads, directory basename for directory
 * uploads). Consumers that need to know whether the source was a file or a
 * directory should inspect the root CID (codec + UnixFS `Data.Type`) rather
 * than rely on a key-name distinction; this matches the IPFS Pinning Service
 * `name` convention and avoids duplicating data the DAG already carries.
 *
 * Synapse SDK has no canonical constant for this yet; if it adopts one we
 * will move to that constant.
 */
export const PIECE_METADATA_NAME_KEY = 'name'

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
 * Merge a derived source name into existing piece metadata under
 * `PIECE_METADATA_NAME_KEY`.
 *
 * Precedence rules:
 * - If `derivedName` is an empty string, returns the input unchanged. There
 *   is no name to attach, so nothing is written.
 * - If the user already set `PIECE_METADATA_NAME_KEY` in `pieceMetadata`,
 *   that value is preserved — including an explicit empty string, which is
 *   treated as a user opt-out from the auto-derived name. The derived value
 *   is dropped silently because this is auto-derived metadata, not a hard
 *   requirement.
 * - Otherwise, the derived name is set under `PIECE_METADATA_NAME_KEY`.
 */
export function withDerivedNameMetadata(
  pieceMetadata: Record<string, string> | undefined,
  derivedName: string
): Record<string, string> | undefined {
  if (derivedName === '') {
    return pieceMetadata
  }

  const existing = pieceMetadata?.[PIECE_METADATA_NAME_KEY]
  if (existing != null) {
    return pieceMetadata
  }

  return {
    ...(pieceMetadata ?? {}),
    [PIECE_METADATA_NAME_KEY]: derivedName,
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
