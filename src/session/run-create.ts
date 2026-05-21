/**
 * Action handler for `filecoin-pin session create`.
 *
 * Single-party flow: owner provides their private key, command generates (or
 * reuses) a session key locally and authorizes it on-chain. Returns the new
 * session private key alongside authorization details.
 */

import pc from 'picocolors'
import type { Hex } from 'viem'
import {
  type CreateSessionKeyProgressEvents,
  type CreateSessionKeyResult,
  createSessionKey,
} from '../core/session/index.js'
import { cancel, createSpinner, intro, outro } from '../utils/cli-helpers.js'
import { log } from '../utils/cli-logger.js'
import { formatCreateSessionKeyOutput } from './format.js'
import { parseValidityDays } from './parse-validity-days.js'
import { resolveNetwork } from './resolve-network.js'
import type { SessionCreateOptions } from './types.js'

export async function runSessionCreate(options: SessionCreateOptions): Promise<CreateSessionKeyResult> {
  intro(pc.bold('Filecoin Pin Session Create'))

  const spinner = createSpinner()

  const privateKey = options.privateKey || process.env.PRIVATE_KEY
  if (!privateKey) {
    cancel('PRIVATE_KEY environment variable or --private-key option is required')
    throw new Error('PRIVATE_KEY environment variable or --private-key option is required')
  }

  const sessionPrivateKey = options.sessionKey || process.env.SESSION_KEY

  let validityDays: number
  try {
    validityDays = parseValidityDays(options.validityDays)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    cancel(message)
    throw error
  }

  const { chain, transport } = await resolveNetwork(options)

  try {
    spinner.start('Authorizing session key on-chain...')

    const onProgress = (event: CreateSessionKeyProgressEvents): void => {
      switch (event.type) {
        case 'createSessionKey:generated':
          spinner.message(`Generated session key ${event.data.sessionAddress}`)
          break
        case 'createSessionKey:reusedSessionKey':
          spinner.message(`Reusing session key ${event.data.sessionAddress}`)
          break
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

    const result = await createSessionKey({
      privateKey: privateKey as Hex,
      ...(sessionPrivateKey ? { sessionPrivateKey: sessionPrivateKey as Hex } : {}),
      validityDays,
      chain,
      transport,
      onProgress,
    })

    spinner.stop(`${pc.green('✓')} Session key authorized on ${chain.name} (chain id ${chain.id})`)

    log.line('')
    log.line(formatCreateSessionKeyOutput(result))
    log.flush()

    outro('Session ready')
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    spinner.stop(`${pc.red('✗')} Session key authorization failed: ${message}`)
    cancel('Session create failed')
    throw error
  }
}
