/**
 * Action handler for `filecoin-pin login`.
 *
 * Generates (or resumes) a session key, saves it before anything else
 * happens, prints and opens the console link where the wallet owner
 * approves the key, waits for the grant on-chain, then prints the granted
 * scopes and the account readiness scorecard. PRD section 6 is the spec
 * for every line printed here.
 *
 * Exit codes: 0 when every requested scope was granted, 2 when the wait
 * timed out or the owner granted fewer scopes (rerun resumes the same
 * key), 1 on an error.
 */

import {
  AddPiecesPermission,
  CreateDataSetPermission,
  type Permission,
  PermissionNames,
} from '@filoz/synapse-core/session-key'
import type { Chain } from '@filoz/synapse-sdk'
import pc from 'picocolors'
import { type Address, createPublicClient } from 'viem'
import { getBlockNumber } from 'viem/actions'
import { EXIT_CODE_INCOMPLETE } from '../common/cli-errors.js'
import {
  buildAuthorizeUrl,
  buildFundingUrl,
  DEFAULT_SUGGESTED_DEPOSIT_USDFC,
  resolveConsoleUrl,
} from '../core/session/console-url.js'
import { generateSessionKeypair } from '../core/session/create-session-key.js'
import { type WatchAuthorizationResult, watchAuthorization } from '../core/session/watch-authorization.js'
import { initializeSynapse } from '../core/synapse/index.js'
import { resolveNetwork } from '../session/resolve-network.js'
import { parseScopes, SCOPE_IDS, SCOPE_PERMISSIONS } from '../session/scopes.js'
import { createSpinner } from '../utils/cli-helpers.js'
import { isTTY, log } from '../utils/cli-logger.js'
import { formatCountdown, formatExpiryDate, shortAddress } from './format.js'
import { openBrowser } from './open-browser.js'
import { checkAccountReadiness, formatReadinessLines } from './readiness.js'
import { getSessionFilePath, readSessionFile, type SavedSession, writeSessionFile } from './session-file.js'
import type { LoginOptions } from './types.js'

const DEFAULT_LOGIN_PERMISSIONS: Permission[] = [CreateDataSetPermission, AddPiecesPermission]

/** Scope id (camelCase, as used in `--scopes` and console URLs) for a permission. */
function scopeIdOf(permission: Permission): string {
  const id = SCOPE_IDS.find((candidate) => SCOPE_PERMISSIONS[candidate] === permission)
  return id ?? PermissionNames[permission] ?? permission
}

function scopeList(permissions: readonly Permission[]): string {
  return permissions.map(scopeIdOf).join(', ')
}

/** Resume the saved key unless `--fresh`; otherwise generate and save a new one. */
function loadOrCreateSession(fresh: boolean | undefined, path: string): { session: SavedSession; resumed: boolean } {
  const saved = fresh ? undefined : readSessionFile(path)
  if (saved !== undefined) return { session: saved, resumed: true }
  const keypair = generateSessionKeypair()
  const session: SavedSession = { sessionKey: keypair.privateKey, sessionAddress: keypair.address }
  writeSessionFile(session, path)
  return { session, resumed: false }
}

/** Print the requested-versus-granted diff and the exit code for a shortfall. */
function reportPartialGrant(requested: readonly Permission[], result: WatchAuthorizationResult): void {
  const granted = new Set(result.granted)
  log.line(`${pc.yellow('⚠')} Authorized with fewer scopes than requested`)
  log.line(`  Requested:  ${scopeList(requested)}`)
  log.line(
    `  Granted:    ${requested
      .map((p) =>
        granted.has(p) ? `${scopeIdOf(p)} ${pc.green('✓')}` : `${scopeIdOf(p)} ${pc.red('✗')} (owner declined)`
      )
      .join('   ')}`
  )
  const canUpload = granted.has(CreateDataSetPermission) && granted.has(AddPiecesPermission)
  const missingIds = result.missing.map(scopeIdOf).join(', ')
  log.line(
    canUpload
      ? `  Uploads will work. Commands needing ${missingIds} will fail until the owner grants them.`
      : `  Commands needing ${missingIds} will fail until the owner grants them.`
  )
}

/** Print the readiness scorecard for `owner` and the funding link when something is missing. */
async function reportReadiness(owner: Address, chain: Chain, consoleUrl: string): Promise<void> {
  const synapse = await initializeSynapse({ walletAddress: owner, readOnly: true, chain })
  const readiness = await checkAccountReadiness(synapse)
  log.line('')
  log.line('  Account readiness for uploads:')
  for (const line of formatReadinessLines(readiness, true)) log.line(line)
  if (!readiness.serviceApproved || readiness.depositUsdfc === 0n) {
    log.line('')
    log.line('  One step fixes both (deposit & approve is a single transaction):')
    log.line(`  ${pc.cyan(pc.underline(buildFundingUrl(consoleUrl, DEFAULT_SUGGESTED_DEPOSIT_USDFC)))}`)
  }
  log.line('')
  log.line(pc.gray('  check anytime: filecoin-pin balance · top up: filecoin-pin dashboard'))
}

/**
 * Run `login`. Returns the process exit code rather than calling
 * `process.exit`, so the command wrapper stays in charge of flushing.
 */
export async function runLogin(options: LoginOptions): Promise<number> {
  const permissions = options.scopes !== undefined ? parseScopes(options.scopes).permissions : DEFAULT_LOGIN_PERMISSIONS
  const { chain, transport } = await resolveNetwork(options)
  const registryAddress = chain.contracts.sessionKeyRegistry?.address
  if (registryAddress === undefined) {
    throw new Error(`No session key registry is configured for chain id ${chain.id}`)
  }
  const consoleUrl = resolveConsoleUrl(chain.id)
  if (consoleUrl === undefined) {
    throw new Error(`No Filecoin Cloud console is known for chain id ${chain.id}. Set CONSOLE_URL to use one.`)
  }

  const path = getSessionFilePath()
  const { session, resumed } = loadOrCreateSession(options.fresh, path)
  const short = shortAddress(session.sessionAddress)
  log.line(`${pc.green('✓')} ${resumed ? 'Resuming session key' : 'Session key generated'}: ${short}`)
  log.line(`${pc.green('✓')} Saved to ${path} (saved BEFORE the browser opens — safe to re-run)`)
  const scopeNote = options.scopes === undefined ? ' (defaults — override with --scopes)' : ''
  log.line(`  Requesting scopes: ${scopeList(permissions)}${scopeNote}`)
  log.line('')

  const client = createPublicClient({ chain, transport })
  const fromBlock = await getBlockNumber(client)
  const scopeIds = permissions.map(scopeIdOf)
  const url = buildAuthorizeUrl(consoleUrl, session.sessionAddress, scopeIds, chain.id)
  log.line('  Approve this key with your wallet in the Filecoin Cloud console:')
  log.line(`  ${pc.cyan(pc.underline(url))}`)
  log.line('')
  log.flush()
  openBrowser(url)

  const spinner = createSpinner()
  const waitLine = (remainingMs: number) =>
    `Waiting for on-chain authorization… ${formatCountdown(remainingMs)} remaining (Ctrl-C safe; rerun \`login\` to resume)`
  if (!isTTY()) log.line(`  ${waitLine(watchDeadlineMs())}`)
  spinner.start(waitLine(watchDeadlineMs()))
  const onSigint = () => {
    spinner.stop(`${pc.yellow('⚠')} Login paused. Your key is saved; rerun \`filecoin-pin login\` to resume.`)
    log.flush()
    process.exit(EXIT_CODE_INCOMPLETE)
  }
  process.once('SIGINT', onSigint)
  let result: WatchAuthorizationResult
  try {
    result = await watchAuthorization({
      client,
      sessionAddress: session.sessionAddress,
      registryAddress,
      permissions,
      fromBlock,
      ...(session.walletAddress !== undefined ? { owner: session.walletAddress } : {}),
      deadlineMs: watchDeadlineMs(),
      onTick: (remainingMs) => spinner.message(waitLine(remainingMs)),
    })
  } finally {
    process.off('SIGINT', onSigint)
  }

  if (result.status === 'timeout' || result.owner === undefined) {
    spinner.stop(
      `${pc.yellow('⚠')} No authorization seen in time. Your key is saved; rerun \`filecoin-pin login\` to resume.`
    )
    log.flush()
    return EXIT_CODE_INCOMPLETE
  }

  writeSessionFile({ ...session, walletAddress: result.owner }, path)
  const expires = result.expiry !== undefined ? ` · expires ${formatExpiryDate(result.expiry)}` : ''
  if (result.status === 'granted') {
    spinner.stop(`${pc.green('✓')} Authorized! Granted: ${scopeList(result.granted)}${expires}`)
  } else {
    spinner.stop('')
    reportPartialGrant(permissions, result)
  }

  await reportReadiness(result.owner, chain, consoleUrl)
  log.flush()
  return result.status === 'granted' ? 0 : EXIT_CODE_INCOMPLETE
}

/** Deadline for the wait; `FILECOIN_PIN_LOGIN_TIMEOUT_MS` shortens it in tests. */
function watchDeadlineMs(): number {
  const override = Number(process.env.FILECOIN_PIN_LOGIN_TIMEOUT_MS)
  return Number.isFinite(override) && override > 0 ? override : 5 * 60 * 1000
}
