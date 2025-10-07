import { RPC_URLS, Synapse, type SynapseOptions } from '@filoz/synapse-sdk'
import type { Logger } from 'pino'

/**
 * Options for {@link initializeSynapse}.
 *
 * Only the fields required for establishing a Synapse connection are exposed
 * so this helper can be reused by the CLI, GitHub Action, and future web UI.
 */
export interface InitializeSynapseConfig {
  /** Private key used for signing transactions. */
  privateKey: string
  /** RPC endpoint for the target Filecoin network. Defaults to calibration. */
  rpcUrl?: string | undefined
}

/**
 * Initialize the Synapse SDK without creating a storage context.
 *
 * This function centralises the connection logic so multiple front-ends can
 * share the same behaviour (validation, logging, default RPC selection).
 * It mirrors the previous implementation from `src/synapse/service.ts` while
 * avoiding module-level side effects.
 *
 * @param config - Connection options for Synapse.
 * @param logger - Logger used for structured output during initialization.
 * @returns A ready-to-use Synapse instance.
 * @throws If required configuration is missing or initialization fails.
 */
export async function initializeSynapse(config: InitializeSynapseConfig, logger: Logger): Promise<Synapse> {
  try {
    logger.info(
      {
        hasPrivateKey: config.privateKey != null,
        rpcUrl: config.rpcUrl,
      },
      'Initializing Synapse'
    )

    if (config.privateKey == null) {
      const error = new Error('PRIVATE_KEY environment variable is required for Synapse integration')
      logger.error(
        {
          event: 'synapse.init.failed',
          error: error.message,
        },
        'Synapse initialization failed: missing PRIVATE_KEY'
      )
      throw error
    }

    logger.info({ event: 'synapse.init' }, 'Initializing Synapse SDK')

    const synapseOptions: SynapseOptions = {
      privateKey: config.privateKey,
      rpcURL: config.rpcUrl ?? RPC_URLS.calibration.websocket,
    }

    const synapse = await Synapse.create(synapseOptions)

    const network = synapse.getNetwork()
    logger.info(
      {
        event: 'synapse.init',
        network,
        rpcUrl: synapseOptions.rpcURL,
      },
      'Synapse SDK initialized'
    )

    return synapse
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error(
      {
        event: 'synapse.init.failed',
        error: errorMessage,
      },
      `Failed to initialize Synapse SDK: ${errorMessage}`
    )
    throw error
  }
}
