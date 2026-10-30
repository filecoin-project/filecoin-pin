/**
 * Action handler for `filecoin-pin login`.
 *
 * Generates (or resumes) a session key, saves it before anything else
 * happens, prints and opens the console link where the wallet owner
 * approves the key, waits for the authorization on-chain, then prints the granted
 * scopes and the account readiness scorecard. With `--scopes …,encrypt` it
 * also takes the group key Grant the console issues for the key (pasted at a
 * prompt, or later with `--grant`). Every printed line is part
 * of the interface: scripts read this output as well as people, so change
 * wording together with the tests that pin it.
 *
 * Exit codes: 0 when every requested scope was granted (and the Grant saved,
 * when `encrypt` was asked for), 2 when the wait timed out, `--no-wait`
 * skipped it, the owner granted too few scopes, or the Grant is still to
 * come (rerun, or `login --grant`, resumes the same key), 1 on an error.
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
import { NETWORK_CHAINS } from '../common/get-rpc-url.js'
import {
  decodeGrantText,
  GrantError,
  keyAgreementParams,
  type OpenedGrant,
  openGroupKeyGrant,
  precheckGroupKeyGrant,
} from '../common/group-key-grant.js'
import {
  buildApproveUrl,
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
import { promptForGrant, readGrantArgument } from './grant-input.js'
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
const SHADOWING_ENV_VARS = ['PRIVATE_KEY', 'SESSION_KEY', 'VIEW_ADDRESS', 'GROUP_KEY_GRANT'] as const

/** `--scopes` token that asks the console for a group key Grant. Not an on-chain permission. */
const ENCRYPT_SCOPE = 'encrypt'

/**
 * Parse login's `--scopes`: the on-chain scopes, plus whether `encrypt` asked for a group
 * key Grant. `encrypt` never reaches the link's `scopes` or the on-chain authorization.
 */
function parseLoginScopes(value: string | undefined): { permissions: Permission[]; encrypt: boolean } {
  if (value === undefined) return { permissions: DEFAULT_LOGIN_PERMISSIONS, encrypt: false }
  const tokens = value.split(',').map((token) => token.trim())
  const encrypt = tokens.some((token) => token.toLowerCase() === ENCRYPT_SCOPE)
  const onChain = tokens.filter((token) => token.toLowerCase() !== ENCRYPT_SCOPE).join(',')
  try {
    return { permissions: parseScopes(onChain).permissions, encrypt }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${reason.replace(/\.?$/, '.')} login also takes ${ENCRYPT_SCOPE}, with at least one of those.`)
  }
}

/**
 * Chain id of a console network slug; mainnet for a session file that never recorded one.
 *
 * @throws for any other network: the console, which issues Grants, serves only these two.
 */
function chainIdOf(network: string | undefined): number {
  if (network === undefined || network === 'mainnet') return NETWORK_CHAINS.mainnet.id
  if (network === 'calibration') return NETWORK_CHAINS.calibration.id
  throw new Error(`login --grant works on mainnet and calibration, not ${network}: Grants come from the console.`)
}

/** Save `opened` with the session, replacing any earlier Grant: one Grant per session key. */
function saveGrant(session: SavedSession, opened: OpenedGrant, path: string): SavedSession {
  const next = { ...session, groupKeyId: opened.groupKeyId, groupKeyGrant: opened.text }
  writeSessionFile(next, path)
  log.line(
    `${pc.green('✓')} Grant saved for group key ${opened.groupKeyId} of ${shortAddress(opened.owner)} · expires ${formatExpiryDate(BigInt(opened.expires))}`
  )
  log.line(pc.gray('  It gives this session key permanent read access to that group key, including future uploads.'))
  return next
}

/** Where to finish when the Grant could not be taken now: the console link and the resume command. */
function reportGrantPending(url: string): void {
  log.line(`${pc.yellow('⚠')} Encrypted uploads need the group key Grant the console shows for this key:`)
  log.line(url)
  log.line('  Then run:  filecoin-pin login --grant <grant>')
  log.line('  or:        filecoin-pin login --grant -    (reads the Grant from stdin)')
}

/**
 * `login --grant` for a session the owner already authorized: check and save the Grant,
 * offline. The network is the saved session's unless `--network` names it.
 */
async function importGrant(
  saved: SavedSession & { walletAddress: Address },
  grantText: string,
  options: LoginOptions,
  path: string
): Promise<number> {
  const network = options.network ?? saved.network
  if (saved.network !== undefined && network !== saved.network) {
    throw new Error(
      `The saved login is for ${saved.network}, not ${network}. Pass --network ${saved.network}, or run \`filecoin-pin login --fresh\` to replace it.`
    )
  }
  const chainId = chainIdOf(network)
  const opened = await openGroupKeyGrant(grantText, {
    sessionKey: saved.sessionKey,
    walletAddress: saved.walletAddress,
    chainId,
  })
  log.line(`${pc.green('✓')} Session key ${saved.sessionAddress} (${network ?? 'mainnet'})`)
  saveGrant(saved, opened, path)
  log.flush()
  return 0
}

/** Whether the saved Grant still opens for the owner that last authorized this key. */
async function savedGrantOpens(session: SavedSession, chainId: number): Promise<boolean> {
  if (session.groupKeyGrant === undefined || session.walletAddress === undefined) return false
  try {
    await openGroupKeyGrant(session.groupKeyGrant, {
      sessionKey: session.sessionKey,
      walletAddress: session.walletAddress,
      chainId,
      groupKeyId: session.groupKeyId,
    })
    return true
  } catch (error) {
    if (!(error instanceof GrantError)) throw error
    return false
  }
}

/**
 * The Grant step after the owner authorized the key: `--grant`, else a saved Grant that
 * still opens, else a prompt on a terminal. Never blocks without one: it prints the link
 * and the resume command instead.
 *
 * @returns whether a valid Grant is saved
 */
async function obtainGrant(
  session: SavedSession & { walletAddress: Address },
  chainId: number,
  url: string,
  grantLinkShown: boolean,
  grantText: string | undefined,
  path: string,
  io: LoginIO
): Promise<boolean> {
  const open = (text: string) =>
    openGroupKeyGrant(text, { sessionKey: session.sessionKey, walletAddress: session.walletAddress, chainId })
  if (grantText !== undefined) {
    try {
      saveGrant(session, await open(grantText), path)
      return true
    } catch (error) {
      if (!(error instanceof GrantError)) throw error
      // The login itself stands; only the Grant is still to come.
      log.line(`${pc.red('✗')} Grant refused: ${error.message}`)
      reportGrantPending(url)
      return false
    }
  }
  if (session.groupKeyGrant !== undefined) {
    try {
      const opened = await openGroupKeyGrant(session.groupKeyGrant, {
        sessionKey: session.sessionKey,
        walletAddress: session.walletAddress,
        chainId,
        groupKeyId: session.groupKeyId,
      })
      log.line(`${pc.green('✓')} Grant for group key ${opened.groupKeyId} already saved`)
      return true
    } catch (error) {
      if (!(error instanceof GrantError)) throw error
      log.line(`${pc.yellow('⚠')} The saved Grant was ignored: ${error.message}`)
    }
  }
  // Both ends a terminal: readline's raw mode, which Ctrl-C and long pastes rely on, needs them.
  if (io.stdin.isTTY !== true || io.stdout.isTTY !== true) {
    reportGrantPending(url)
    return false
  }
  if (!grantLinkShown) {
    // The link shown before the wait left the group key step out: the saved Grant opened then.
    log.line('  Open this link for the group key step:')
    log.line(url)
  }
  log.line(`  In the console, approve the group key step for session key ${session.sessionAddress}`)
  log.line('  and copy the Grant it shows.')
  log.flush()
  const opened = await promptForGrant(open, io.stdin, io.stdout)
  if (opened === undefined) {
    reportGrantPending(url)
    return false
  }
  saveGrant(session, opened, path)
  return true
}

/** The streams `login` reads a Grant from and prompts on; a test passes its own. */
export interface LoginIO {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
  stdout: NodeJS.WritableStream & { isTTY?: boolean }
}

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
  return saved?.walletAddress === undefined ? { session, resumed: false } : { session, resumed: false, replaced: saved }
}

/**
 * Exit 0 only when every requested scope was granted. The caller asked for a
 * set; a scope the owner declined is a shortfall for whatever that caller
 * meant to run, so the exit code says so and the printed diff names it.
 */
function grantedEveryRequested(requested: readonly Permission[], granted: readonly Permission[]): boolean {
  const have = new Set(granted)
  return requested.every((p) => have.has(p))
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
  log.line(`  Rerun \`filecoin-pin login\` to ask again, or \`login --scopes\` with only the scopes you need.`)
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
  const needsApproval = !readiness.serviceApproved
  const needsDeposit = readiness.depositUsdfc === 0n
  if (needsApproval || needsDeposit) {
    log.line('')
    if (needsDeposit) {
      log.line(
        needsApproval
          ? '  One step fixes both (deposit & approve is a single transaction):'
          : '  Deposit USDFC (amount pre-filled):'
      )
      log.line(buildFundingUrl(consoleUrl, DEFAULT_SUGGESTED_DEPOSIT_USDFC, chain.id))
    } else {
      log.line('  Approve the storage service in the console:')
      log.line(buildApproveUrl(consoleUrl, chain.id))
    }
  }
  log.line('')
  log.line(pc.gray('  check anytime: filecoin-pin balance · top up: filecoin-pin dashboard'))
}

/**
 * Run `login`. Returns the process exit code rather than calling
 * `process.exit`, so the command wrapper stays in charge of flushing. The
 * one exception is Ctrl-C during the wait: its handler stops the spinner
 * and exits 2 itself, because the process is going down either way.
 */
export async function runLogin(
  options: LoginOptions,
  io: LoginIO = { stdin: process.stdin, stdout: process.stdout }
): Promise<number> {
  const { permissions, encrypt } = parseLoginScopes(options.scopes)
  if (options.grant !== undefined && options.fresh) {
    // Refused before the saved key is replaced: a Grant names its key, and a fresh one has none yet.
    throw new Error(
      '--grant imports a Grant for the saved session key; a --fresh key has none yet. Run `login --fresh` first, then approve the new key and take its Grant.'
    )
  }
  const path = getSessionFilePath()
  const saved = options.grant === undefined ? undefined : readSessionFile(path)
  if (options.grant !== undefined && saved === undefined) {
    // Refused before anything is written: a new key could never match the Grant.
    throw new Error(
      'No saved session to import a Grant for. Run `filecoin-pin login --scopes createDataSet,addPieces,encrypt` first.'
    )
  }
  // Read and decoded first, so a wrong paste fails now rather than after the wait.
  const grantText = options.grant === undefined ? undefined : await readGrantArgument(options.grant, io.stdin)
  if (grantText !== undefined) decodeGrantText(grantText)
  // `--grant` asks for the Grant step whether or not `--scopes` names encrypt.
  const wantGrant = encrypt || grantText !== undefined
  let networkOptions: LoginOptions = options
  if (grantText !== undefined) {
    if (saved?.walletAddress !== undefined) {
      // Offline: the owner is known and the Grant names its network, so no RPC is needed.
      return importGrant({ ...saved, walletAddress: saved.walletAddress }, grantText, options, path)
    }
    // Not yet seen authorized: resume the saved key on its own network, then take the Grant.
    if (options.network === undefined && options.rpcUrl === undefined && saved?.network !== undefined) {
      networkOptions = { ...options, network: saved.network }
    }
  }

  const { chain, transport, rpcUrl } = await resolveNetwork(networkOptions)
  const registryAddress = chain.contracts.sessionKeyRegistry?.address
  if (registryAddress === undefined) {
    throw new Error(`No session key registry is configured for chain id ${chain.id}`)
  }
  const network = consoleNetworkSlug(chain.id)
  if (network === undefined && wantGrant) {
    throw new Error(
      `Group key Grants come from the Filecoin Cloud console, which has no page for chain id ${chain.id}. On this network, encrypt in owner mode: set PRIVATE_KEY to the wallet key.`
    )
  }
  if (network === undefined) {
    throw new Error(
      `The Filecoin Cloud console has no pairing page for chain id ${chain.id}. login works on mainnet and calibration; on other networks use \`filecoin-pin session create\` with the wallet key.`
    )
  }
  const consoleUrl = resolveConsoleUrl()

  const { session, resumed, replaced } = loadOrCreateSession(options.fresh, network, path)
  // Checks that need no owner or network, before the link and the wait.
  if (grantText !== undefined) precheckGroupKeyGrant(grantText, session.sessionKey)
  const short = shortAddress(session.sessionAddress)
  log.line(`${pc.green('✓')} ${resumed ? 'Resuming session key' : 'Session key generated'}: ${short} (${network})`)
  log.line(`${pc.green('✓')} Saved to ${path} (owner-readable only, saved BEFORE the browser opens — safe to re-run)`)
  if (replaced !== undefined) {
    log.line(
      `${pc.yellow('⚠')} Replaced ${shortAddress(replaced.sessionAddress)}, which stays authorized on chain until it expires. Revoke it early on the console's Session keys page.`
    )
    if (replaced.groupKeyGrant !== undefined) {
      log.line(
        `${pc.yellow('⚠')} Dropped its Grant for group key ${replaced.groupKeyId}. The replaced key can still open that Grant: revoking it does not take back read access.`
      )
    }
  }
  for (const name of SHADOWING_ENV_VARS) {
    if (process.env[name] !== undefined && process.env[name] !== '') {
      log.line(
        `${pc.yellow('⚠')} ${name} is set in this shell and takes precedence over the saved login. Unset it to use this session key.`
      )
    }
  }
  const scopeNote = options.scopes === undefined ? ' (defaults — override with --scopes)' : ''
  const grantNote = wantGrant ? ` + ${ENCRYPT_SCOPE} (group key Grant)` : ''
  log.line(`  Requesting scopes: ${scopeList(permissions)}${grantNote}${scopeNote}`)
  if (wantGrant) {
    // The console shows the address it wraps the Grant to; the owner compares the two.
    log.line(`  Session address: ${session.sessionAddress} (the console must show the same one)`)
  }
  log.line('')

  const scopeIds = permissions.map(scopeIdOf)
  const keyAgreement = wantGrant ? await keyAgreementParams(session.sessionKey) : undefined
  // With pubkey, the console asks the owner for a Grant wrapped to this session key.
  const grantUrl = buildAuthorizeUrl(consoleUrl, session.sessionAddress, scopeIds, chain.id, keyAgreement)
  // A saved Grant that still opens needs no new one, so the link leaves the group key step out.
  const keepSavedGrant = wantGrant && grantText === undefined && (await savedGrantOpens(session, chain.id))
  const url = keepSavedGrant ? buildAuthorizeUrl(consoleUrl, session.sessionAddress, scopeIds, chain.id) : grantUrl
  log.line('  Approve this key with your wallet in the Filecoin Cloud console:')
  // The link on its own line, unstyled, so it copies and parses cleanly.
  log.line(url)
  log.line('')
  log.flush()
  // A Grant already in hand means the owner has been to the console.
  if (options.browser !== false && grantText === undefined) openBrowser(url)

  // The link is already on screen: an RPC that is down here costs the wait, not the pairing.
  const client = createPublicClient({ chain, transport })

  if (options.wait === false) {
    // This exit tells the owner to rerun `login`, and the grant is usually
    // mined before they do, so it needs the same resume marker the wait
    // records. Best effort: the pairing is done and an RPC that is down here
    // must not undo it; a rerun without a marker starts at its own head.
    if (session.fromBlock === undefined) {
      try {
        writeSessionFile({ ...session, fromBlock: await getBlockNumber(client) }, path)
      } catch {
        // A rerun will start at its own head; the pairing still stands.
      }
    }
    log.line(
      `${pc.yellow('⚠')} Not waiting for the authorization. Approve the key, then rerun \`filecoin-pin login\` to check it.`
    )
    if (grantText !== undefined) {
      // Never dropped silently: the Grant can be checked only once the owner is known.
      log.line(
        "  The Grant was not imported: the session key isn't authorized yet. Approve it in the console, then run `filecoin-pin login --grant …` again."
      )
    } else if (wantGrant && !keepSavedGrant) {
      reportGrantPending(url)
    }
    log.flush()
    return EXIT_CODE_INCOMPLETE
  }

  // A resumed wait scans from where the first one started, so a grant that
  // landed while nothing was watching is still found. The owner authorizes
  // once; a rerun that scanned from the current block would wait for a second
  // event that never comes.
  const fromBlock = session.fromBlock ?? (await getBlockNumber(client))
  if (session.fromBlock === undefined) writeSessionFile({ ...session, fromBlock }, path)
  const deadlineMs = options.timeout === undefined ? DEFAULT_WATCH_DEADLINE_MS : options.timeout * 1000
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
      ...(session.walletAddress === undefined ? {} : { owner: session.walletAddress }),
      onProgress: (event) => {
        if (event.type === 'watch:tick') spinner.message(waitLine(event.data.remainingMs))
      },
    })
  } catch (error) {
    spinner.stop(
      `${pc.red('✗')} Could not watch for the authorization. Your key is saved; rerun \`filecoin-pin login\` to resume.`
    )
    throw error
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

  const authorized = { ...session, fromBlock, walletAddress: result.owner }
  writeSessionFile(authorized, path)
  const expires = result.expiry === undefined ? '' : ` · expires ${formatExpiryDate(result.expiry)}`
  if (result.status === 'granted') {
    spinner.stop(`${pc.green('✓')} Authorized! Granted: ${scopeList(result.granted)}${expires}`)
  } else {
    spinner.stop('')
    reportPartialGrant(permissions, result)
  }
  const haveGrant = wantGrant
    ? await obtainGrant(authorized, chain.id, grantUrl, !keepSavedGrant, grantText, path, io)
    : true

  // Funding never blocks login: a failed readiness read is reported, not fatal.
  try {
    await reportReadiness(result.owner, chain, rpcUrl, consoleUrl)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log.line(`${pc.yellow('⚠')} Could not read account readiness: ${reason}. Run \`filecoin-pin balance\` to check.`)
  }
  log.flush()
  return grantedEveryRequested(permissions, result.granted) && haveGrant ? 0 : EXIT_CODE_INCOMPLETE
}
