/**
 * Action handler for `filecoin-pin session revoke <session-address>`.
 *
 * Owner side: signs the on-chain `revoke()` transaction that removes the
 * Filecoin Pin FWSS permissions from an authorized session address.
 */

import { confirm, isCancel } from '@clack/prompts'
import pc from 'picocolors'
import { type Account, createWalletClient, getAddress, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  type RevokeSessionProgressEvents,
  type RevokeSessionResult,
  revokeSessionAddress,
} from '../core/session/index.js'
import { cancel, createSpinner, intro, isInteractive, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import { formatRevokeSessionOutput } from './format.js'
import { resolveNetwork } from './resolve-network.js'
import type { SessionRevokeOptions } from './types.js'

export async function runSessionRevoke(options: SessionRevokeOptions): Promise<RevokeSessionResult> {
  intro(pc.bold('Filecoin Pin Session Revoke'))

  const privateKey = options.privateKey || process.env.PRIVATE_KEY
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

  const { chain, transport } = await resolveNetwork(options)

  const ownerAccount: Account = privateKeyToAccount(privateKey as Hex)

  log.section('About to revoke', [
    pc.gray(`Owner:           ${ownerAccount.address}`),
    pc.gray(`Session address: ${sessionAddress}`),
    pc.gray(`Chain:           ${chain.name} (id ${chain.id})`),
    pc.yellow('This revokes the Filecoin Pin FWSS permissions for this session address.'),
  ])
  log.flush()

  if (isInteractive()) {
    const proceed = await confirm({
      message: `Revoke ${sessionAddress} for owner ${ownerAccount.address}?`,
      initialValue: false,
    })
    if (isCancel(proceed) || proceed !== true) {
      cancel('Revocation cancelled')
      throw new Error('Revocation cancelled')
    }
  }

  const spinner = createSpinner()
  try {
    spinner.start('Revoking session address on-chain...')

    const client = createWalletClient({ account: ownerAccount, chain, transport })

    const onProgress = (event: RevokeSessionProgressEvents): void => {
      switch (event.type) {
        case 'revokeSession:submitting':
          spinner.message(`Submitting revoke() to ${event.data.registryAddress}`)
          break
        case 'revokeSession:submitted':
          spinner.message(`Submitted ${event.data.txHash}`)
          break
        case 'revokeSession:confirmed':
          spinner.message(`Confirmed in block ${event.data.blockNumber}`)
          break
      }
    }

    const result = await revokeSessionAddress(client, {
      sessionAddress,
      onProgress,
    })

    spinner.stop(`${pc.green('✓')} Session address revoked on ${chain.name} (chain id ${chain.id})`)

    log.line('')
    log.line(formatRevokeSessionOutput(result))
    log.flush()

    outro('Revocation complete')
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    spinner.stop(`${pc.red('✗')} Revocation failed: ${message}`)
    cancel('Session revoke failed')
    throw error
  }
}
