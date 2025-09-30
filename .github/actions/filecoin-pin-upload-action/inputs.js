import { resolve } from 'node:path'
import { ethers } from 'ethers'

/**
 * Get input value from environment variables
 * @param {string} name - Input name
 * @param {string} fallback - Default value
 * @returns {string} Input value
 */
export function getInput(name, fallback = '') {
  return (process.env[`INPUT_${name.toUpperCase()}`] ?? fallback).trim()
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
 * @returns {Object} Parsed and validated inputs
 */
export function parseInputs() {
  const privateKey = getInput('privateKey')
  const contentPath = getInput('path', 'dist')
  const minDaysRaw = getInput('minDays', '10')
  const minBalanceRaw = getInput('minBalance', '')
  const maxTopUpRaw = getInput('maxTopUp', '')
  const withCDN = parseBoolean(getInput('withCDN', 'false'))
  const token = getInput('token', 'USDFC')
  const providerAddress = getInput('providerAddress', '0xa3971A7234a3379A1813d9867B531e7EeB20ae07')

  // Validate required inputs
  if (!privateKey) {
    throw new Error('privateKey is required')
  }

  // Parse numeric values
  let minDays = Number(minDaysRaw)
  if (!Number.isFinite(minDays) || minDays < 0) minDays = 0

  const minBalance = minBalanceRaw ? ethers.parseUnits(minBalanceRaw, 18) : 0n
  const maxTopUp = maxTopUpRaw ? ethers.parseUnits(maxTopUpRaw, 18) : undefined

  // Validate token selection (currently USDFC only)
  if (token && token.toUpperCase() !== 'USDFC') {
    throw new Error('Only USDFC is supported at this time for payments. Token override will be enabled later.')
  }

  return {
    privateKey,
    contentPath,
    minDays,
    minBalance,
    maxTopUp,
    withCDN,
    token,
    providerAddress,
  }
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
