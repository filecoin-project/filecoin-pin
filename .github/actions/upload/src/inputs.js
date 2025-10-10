import { resolve } from 'node:path'
import { ethers } from 'ethers'
import { ERROR_CODES, FilecoinPinError, getErrorMessage } from './errors.js'

/**
 * @typedef {import('./types.js').ParsedInputs} ParsedInputs
 */

/**
 * Check if object has own property
 * @param {any} object - Object to check
 * @param {string} key - Property key
 * @returns {boolean} True if object has own property
 */
const own = (object, key) => Object.hasOwn(object, key)

/** @type {any} */
let cachedInputsJson

function readInputsJson() {
  if (cachedInputsJson !== undefined) return cachedInputsJson

  const raw = process.env.INPUTS_JSON
  if (!raw) {
    cachedInputsJson = null
    return cachedInputsJson
  }

  try {
    cachedInputsJson = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Failed to parse INPUTS_JSON: ${error instanceof Error ? error.message : String(error)}`)
  }

  return cachedInputsJson
}

/**
 * Convert value to string with fallback
 * @param {any} value - Value to convert
 * @param {string} fallback - Fallback value
 * @returns {string} String representation
 */
function toStringValue(value, fallback = '') {
  if (value === undefined || value === null) return String(fallback ?? '')
  return typeof value === 'string' ? value : String(value)
}

/**
 * Get input value from environment variables
 * @param {string} name - Input name
 * @param {string} fallback - Default value
 * @returns {string} Input value
 */
export function getInput(name, fallback = '') {
  const json = readInputsJson()
  if (json && own(json, name)) {
    return toStringValue(json[name], fallback).trim()
  }

  const envKey = `INPUT_${name.toUpperCase()}`
  if (process.env[envKey] !== undefined && process.env[envKey] !== null) {
    return toStringValue(process.env[envKey], fallback).trim()
  }

  return toStringValue(fallback).trim()
}

/**
 * Parse boolean value from string
 * @param {any} v - Value to parse
 * @returns {boolean} Parsed boolean
 */
export function parseBoolean(v) {
  if (typeof v === 'boolean') return v
  if (typeof v !== 'string') return false
  const s = v.trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes'
}

/**
 * Parse and validate all action inputs
 * @param {string} phase - Action phase (compute, from-cache, or upload/single)
 * @returns {ParsedInputs} Parsed and validated inputs
 */
export function parseInputs(phase = 'single') {
  const walletPrivateKey = getInput('walletPrivateKey')
  const contentPath = getInput('path')
  const networkRaw = getInput('network')
  const minStorageDaysRaw = getInput('minStorageDays', '')
  const filecoinPayBalanceLimitRaw = getInput('filecoinPayBalanceLimit', '')
  const withCDN = parseBoolean(getInput('withCDN', 'false'))
  const providerAddress = getInput('providerAddress', undefined)
  const dryRun = parseBoolean(getInput('dryRun', 'false'))

  if (!contentPath) {
    throw new FilecoinPinError('path is required', ERROR_CODES.INVALID_INPUT)
  }

  const normalizedNetwork = networkRaw.trim().toLowerCase()
  /** @type {'mainnet' | 'calibration'} */
  const network = /** @type {'mainnet' | 'calibration'} */ (normalizedNetwork)
  if (!network || (network !== 'mainnet' && network !== 'calibration')) {
    throw new FilecoinPinError('network must be either "mainnet" or "calibration"', ERROR_CODES.INVALID_INPUT)
  }

  // Validate required inputs (only for phases that need wallet)
  // Build mode (compute phase) doesn't need the wallet
  if (phase !== 'compute' && !walletPrivateKey) {
    throw new Error('walletPrivateKey is required')
  }

  // Validate wallet private key format early to avoid network calls
  if (phase !== 'compute' && walletPrivateKey) {
    try {
      // Try to create a wallet from the private key to validate format
      new ethers.Wallet(walletPrivateKey)
    } catch (error) {
      throw new FilecoinPinError(
        `Invalid wallet private key format: ${getErrorMessage(error)}`,
        ERROR_CODES.INVALID_PRIVATE_KEY
      )
    }
  }

  // Parse numeric values
  let minStorageDays = Number(minStorageDaysRaw)
  if (!Number.isFinite(minStorageDays) || minStorageDays < 0) minStorageDays = 0

  const filecoinPayBalanceLimit = filecoinPayBalanceLimitRaw
    ? ethers.parseUnits(filecoinPayBalanceLimitRaw, 18)
    : undefined

  if (minStorageDays > 0 && filecoinPayBalanceLimit == null) {
    throw new Error('filecoinPayBalanceLimit must be set when minStorageDays is provided')
  }

  /** @type {ParsedInputs} */
  const parsedInputs = {
    walletPrivateKey,
    contentPath,
    network,
    minStorageDays,
    filecoinPayBalanceLimit,
    withCDN,
    providerAddress,
    dryRun,
  }

  return parsedInputs
}

/**
 * Resolve content path relative to workspace
 * @param {string} contentPath - Content path
 * @returns {string} Absolute path
 */
export function resolveContentPath(contentPath) {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd()
  return resolve(workspace, contentPath)
}
