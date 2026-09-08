/**
 * Action handler for `filecoin-pin login`.
 *
 * Generates (or resumes) a session key, saves it before anything else
 * happens, prints and opens the console link where the wallet owner
 * approves the key, waits for the grant on-chain, then prints the granted
 * scopes and the account readiness scorecard. PRD section 6 is the spec
 * for every line printed here.
 *
 * Exit codes: 0 when the key can upload (every requested scope, or at least
 * createDataSet and addPieces), 2 when the wait timed out, `--no-wait`
 * skipped it, or the owner granted too few scopes (rerun resumes the same
 * key), 1 on an error.
 */

import {
  AddPiecesPermission,
  CreateDataSetPermission,
  type Permission,
  PermissionNames,
} from '@filoz/synapse-core/session-key'
import type { FilecoinChain } from '@filoz/synapse-sdk'
import pc from 'picocolors'
import { type Address, createPublicClient } from 'viem'
import { getBlockNumber } from 'viem/actions'
import { EXIT_CODE_INCOMPLETE } from '../common/cli-errors.js'
import {
  buildAuthorizeUrl,
  buildFundingUrl,
  consoleNetworkSlug,
  DEFAULT_SUGGESTED_DEPOSIT_USDFC,
  resolveConsoleUrl,
} from '../core/session/console-url.js'
import { generateSessionKeypair } from '../core/session/create-session-key.js'
import {
  DEFAULT_WATCH_DEADLINE_MS,
  type WatchAuthorizationResult,
  watchAuthorization,
} from '../core/session/watch-authorization.js'
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

/** Credentials in the shell that would shadow the saved login for every later command. */
const SHADOWING_ENV_VARS = ['PRIVATE_KEY', 'SESSION_KEY', 'VIEW_ADDRESS'] as const

interface LoadedSession {
  session: SavedSession
  resumed: boolean
  /** A previously authorized key that `--fresh` is replacing; it stays live on chain. */
  replaced?: SavedSession
}

/**
 * Resume the saved key unless `--fresh`; otherwise generate and save a new
 * one for `network`. A saved key made for another network is refused: its
 * grant lives on that chain, so resuming it here could never succeed.
 */
function loadOrCreateSession(fresh: boolean | undefined, network: string, path: string): LoadedSession {
  const saved = readSessionFile(path)
  if (saved !== undefined && !fresh) {
    if (saved.network !== undefined && saved.network !== network) {
      throw new Error(
        `The saved login is for ${saved.network}, not ${network}. Pass --network ${saved.network} to resume it, or --fresh to replace it.`
      )
    }
    return { session: saved.network === undefined ? { ...saved, network } : saved, resumed: true }
  }
  const keypair = generateSessionKeypair()
  const session: SavedSession = { sessionKey: keypair.privateKey, sessionAddress: keypair.address, network }
  writeSessionFile(session, path)
  return saved?.walletAddress !== undefined ? { session, resumed: false, replaced: saved } : { session, resumed: false }
}

/** Exit 0 when the key can upload: everything asked for, or at least the two upload scopes. */
function canUploadWith(requested: readonly Permission[], granted: readonly Permission[]): boolean {
  const have = new Set(granted)
  return requested.every((p) => have.has(p)) || (have.has(CreateDataSetPermission) && have.has(AddPiecesPermission))
}

/** Print the requested-versus-granted diff and the exit code for a shortfall. */
function reportPartialGrant(requested: readonly Permission[], result: WatchAuthorizationResult): void {
  const granted = new Set(result.granted)
  log.line(
    result.granted.length === 0
      ? `${pc.yellow('⚠')} Authorized with none of the requested scopes`
      : `${pc.yellow('⚠')} Authorized with fewer scopes than requested`
  )
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
async function reportReadiness(
  owner: Address,
  chain: FilecoinChain,
  rpcUrl: string,
  consoleUrl: string
): Promise<void> {
  const synapse = await initializeSynapse({ walletAddress: owner, readOnly: true, chain, rpcUrl })
  const readiness = await checkAccountReadiness(synapse)
  log.line('')
  log.line('  Account readiness for uploads:')
  for (const line of formatReadinessLines(readiness, true)) log.line(line)
  if (!readiness.serviceApproved || readiness.depositUsdfc === 0n) {
    log.line('')
    log.line('  One step fixes both (deposit & approve is a single transaction):')
    log.line(buildFundingUrl(consoleUrl, DEFAULT_SUGGESTED_DEPOSIT_USDFC, chain.id))
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
  const { chain, transport, rpcUrl } = await resolveNetwork(options)
  const registryAddress = chain.contracts.sessionKeyRegistry?.address
  if (registryAddress === undefined) {
    throw new Error(`No session key registry is configured for chain id ${chain.id}`)
  }
  const network = consoleNetworkSlug(chain.id)
  if (network === undefined) {
    throw new Error(
      `The Filecoin Cloud console has no pairing page for chain id ${chain.id}. login works on mainnet and calibration; on other networks use \`filecoin-pin session create\` with the wallet key.`
    )
  }
  const consoleUrl = resolveConsoleUrl()

  const path = getSessionFilePath()
  const { session, resumed, replaced } = loadOrCreateSession(options.fresh, network, path)
  const short = shortAddress(session.sessionAddress)
  log.line(`${pc.green('✓')} ${resumed ? 'Resuming session key' : 'Session key generated'}: ${short} (${network})`)
  log.line(`${pc.green('✓')} Saved to ${path} (owner-readable only, saved BEFORE the browser opens — safe to re-run)`)
  if (replaced !== undefined) {
    log.line(
      `${pc.yellow('⚠')} Replaced ${shortAddress(replaced.sessionAddress)}, which stays authorized on chain until it expires. Revoke it early on the console's Session keys page.`
    )
  }
  for (const name of SHADOWING_ENV_VARS) {
    if (process.env[name] !== undefined && process.env[name] !== '') {
      log.line(
        `${pc.yellow('⚠')} ${name} is set in this shell and takes precedence over the saved login. Unset it to use this session key.`
      )
    }
  }
  const scopeNote = options.scopes === undefined ? ' (defaults — override with --scopes)' : ''
  log.line(`  Requesting scopes: ${scopeList(permissions)}${scopeNote}`)
  log.line('')

  const client = createPublicClient({ chain, transport })
  const fromBlock = await getBlockNumber(client)
  const scopeIds = permissions.map(scopeIdOf)
  const url = buildAuthorizeUrl(consoleUrl, session.sessionAddress, scopeIds, chain.id)
  log.line('  Approve this key with your wallet in the Filecoin Cloud console:')
  // The link on its own line, unstyled, so it copies and parses cleanly.
  log.line(url)
  log.line('')
  log.flush()
  if (options.browser !== false) openBrowser(url)

  if (options.wait === false) {
    log.line(
      `${pc.yellow('⚠')} Not waiting for the grant. Approve the key, then rerun \`filecoin-pin login\` to check it.`
    )
    log.flush()
    return EXIT_CODE_INCOMPLETE
  }

  const deadlineMs = options.timeout !== undefined ? options.timeout * 1000 : DEFAULT_WATCH_DEADLINE_MS
  const spinner = createSpinner()
  const waitLine = (remainingMs: number) =>
    `Waiting for on-chain authorization… ${formatCountdown(remainingMs)} remaining (Ctrl-C safe; rerun \`login\` to resume)`
  // Registered before the spinner starts: clack installs its own SIGINT
  // handler in start(), and the first listener to call process.exit wins.
  const onSigint = () => {
    spinner.stop(`${pc.yellow('⚠')} Login paused. Your key is saved; rerun \`filecoin-pin login\` to resume.`)
    log.flush()
    process.exit(EXIT_CODE_INCOMPLETE)
  }
  process.once('SIGINT', onSigint)
  if (!isTTY()) log.line(`  ${waitLine(deadlineMs)}`)
  spinner.start(waitLine(deadlineMs))
  let result: WatchAuthorizationResult
  try {
    result = await watchAuthorization({
      client,
      sessionAddress: session.sessionAddress,
      registryAddress,
      permissions,
      fromBlock,
      deadlineMs,
      ...(session.walletAddress !== undefined ? { owner: session.walletAddress } : {}),
      onProgress: (event) => {
        if (event.type === 'watch:tick') spinner.message(waitLine(event.data.remainingMs))
      },
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

  // Funding never blocks login: a failed readiness read is reported, not fatal.
  try {
    await reportReadiness(result.owner, chain, rpcUrl, consoleUrl)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log.line(`${pc.yellow('⚠')} Could not read account readiness: ${reason}. Run \`filecoin-pin balance\` to check.`)
  }
  log.flush()
  return canUploadWith(permissions, result.granted) ? 0 : EXIT_CODE_INCOMPLETE
}
