import { createConfig } from './config.js'
import { name as packageName, version as packageVersion } from './core/utils/version.js'
import { createFilecoinPinningServer } from './filecoin-pinning-server.js'
import { createLogger } from './logger.js'

export interface ServiceInfo {
  service: string
  version: string
}

function getServiceInfo(): ServiceInfo {
  return {
    service: packageName,
    version: packageVersion,
  }
}

export async function startServer(): Promise<void> {
  const serviceInfo = getServiceInfo()
  const config = createConfig()
  const logger = createLogger(config)

  logger.info(`Starting ${serviceInfo.service} v${serviceInfo.version} daemon...`)

  try {
    const { server, pinStore } = await createFilecoinPinningServer(config, logger, serviceInfo)

    process.on('SIGINT', () => {
      void (async () => {
        logger.info('Received SIGINT, shutting down gracefully...')
        await server.close()
        await pinStore.stop()
        process.exit(0)
      })()
    })

    process.on('SIGTERM', () => {
      void (async () => {
        logger.info('Received SIGTERM, shutting down gracefully...')
        await server.close()
        await pinStore.stop()
        process.exit(0)
      })()
    })

    // Get the actual port the server is listening on
    const address = server.server.address()
    const port = typeof address === 'string' ? address : address?.port

    logger.info({ port }, `${serviceInfo.service} daemon started successfully`)
    logger.info(`Pinning service listening on http://${config.host}:${String(port)}`)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error(
      {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      },
      `Failed to start daemon: ${errorMessage}`
    )

    // Also print a user-friendly message to stderr for clarity
    if (errorMessage.includes('No authentication')) {
      console.error('\n❌ Error: Authentication is required to start the pinning server')
      console.error('   Private key:   --private-key <key>  or  PRIVATE_KEY=0x...')
      console.error('   Session key:   --wallet-address <addr> --session-key <key>')
      console.error('                  or  WALLET_ADDRESS=0x... SESSION_KEY=0x...\n')
    }

    process.exit(1)
  }
}
