/**
 * Action handler for `filecoin-pin session authorize <session-address>`.
 *
 * Two-party owner side: signs the on-chain `login()` authorizing an
 * externally generated session address. The address can come from any source
 * the holder controls (MetaMask, hardware wallet, `cast wallet new`,
 * `filecoin-pin session generate`, ...); only the address itself is needed.
 */

import { confirm, isCancel } from '@clack/prompts'
import pc from 'picocolors'
import { type Account, createWalletClient, getAddress, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { setIncompleteExitCode } from '../common/cli-errors.js'
import {
  type AuthorizeSessionProgressEvents,
  type AuthorizeSessionResult,
  authorizeSessionAddress,
} from '../core/session/index.js'
import { cancel, createSpinner, intro, isInteractive, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import { formatAuthorizeSessionOutput } from './format.js'
import { parseValidityDays } from './parse-validity-days.js'
import { resolveNetwork } from './resolve-network.js'
import type { SessionAuthorizeOptions } from './types.js'

/**
 * Authorize a session address on-chain. Returns the authorization result, or
 * `undefined` when the user declines the interactive confirmation (in which
 * case the process exit code is set to {@link EXIT_CODE_INCOMPLETE}).
 */
export async function runSessionAuthorize(
  options: SessionAuthorizeOptions
): Promise<AuthorizeSessionResult | undefined> {
  intro(pc.bold('Filecoin Pin Session Authorize'))

  const privateKey = options.privateKey
  if (!privateKey) {
    cancel('PRIVATE_KEY environment variable or --private-key option is required')
    throw new Error('PRIVATE_KEY environment variable or --private-key option is required')
  }

  let sessionAddress: ReturnType<typeof getAddress>
  try {
    sessionAddress = getAddress(options.sessionAddress)
  } catch {
    cancel(`Invalid session address: ${options.sessionAddress}`)
    throw new Error(`Invalid session address: ${options.sessionAddress}`)
  }

  let validityDays: number
  try {
    validityDays = parseValidityDays(options.validityDays)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    cancel(message)
    throw error
  }

  const { chain, transport } = await resolveNetwork(options)

  const ownerAccount: Account = privateKeyToAccount(privateKey as Hex)

  log.section('About to authorize', [
    pc.gray(`Owner:           ${ownerAccount.address}`),
    pc.gray(`Session address: ${sessionAddress}`),
    pc.gray(`Chain:           ${chain.name} (id ${chain.id})`),
    pc.gray(`Validity:        ${validityDays} days`),
    pc.yellow('Verify the session address out-of-band before continuing.'),
  ])
  log.flush()

  if (isInteractive()) {
    const proceed = await confirm({
      message: `Authorize ${sessionAddress} to act on behalf of ${ownerAccount.address}?`,
      initialValue: false,
    })
    if (isCancel(proceed) || proceed !== true) {
      cancel('Authorization cancelled')
      // User declined: not a failure, but nothing was authorized. Signal
      // "incomplete" (2) distinctly from success (0) and a caught error (1).
      setIncompleteExitCode()
      return undefined
    }
  }

  const spinner = createSpinner()
  try {
    spinner.start('Authorizing session address on-chain...')

    const client = createWalletClient({ account: ownerAccount, chain, transport })

    const onProgress = (event: AuthorizeSessionProgressEvents): void => {
      switch (event.type) {
        case 'authorizeSession:submitting':
          spinner.message(`Submitting login() to ${event.data.registryAddress}`)
          break
        case 'authorizeSession:submitted':
          spinner.message(`Submitted ${event.data.txHash}`)
          break
        case 'authorizeSession:confirmed':
          spinner.message(`Confirmed in block ${event.data.blockNumber}`)
          break
      }
    }

    const result = await authorizeSessionAddress(client, {
      sessionAddress,
      validityDays,
      onProgress,
    })

    spinner.stop(`${pc.green('✓')} Session address authorized on ${chain.name} (chain id ${chain.id})`)

    log.line('')
    log.line(formatAuthorizeSessionOutput(result))
    log.flush()

    outro('Authorization complete')
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    spinner.stop(`${pc.red('✗')} Authorization failed: ${message}`)
    cancel('Session authorize failed')
    throw error
  }
}
