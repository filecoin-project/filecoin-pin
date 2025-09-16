import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createConfig } from './config.js'
import { createFilecoinPinningServer } from './filecoin-pinning-server.js'
import { createLogger } from './logger.js'

export interface ServiceInfo {
  service: string
  version: string
}

function getServiceInfo(): ServiceInfo {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))
  return {
    service: packageJson.name,
    version: packageJson.version,
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
    if (errorMessage.includes('PRIVATE_KEY')) {
      console.error('\n❌ Error: PRIVATE_KEY environment variable is required')
      console.error('   Please set your private key: export PRIVATE_KEY=0x...')
      console.error('   Or run with: PRIVATE_KEY=0x... npm start\n')
    }

    process.exit(1)
  }
}
