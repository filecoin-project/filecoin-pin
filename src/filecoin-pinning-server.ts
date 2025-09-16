import fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import type { Config } from './config.js'
import { FilecoinPinStore, type PinOptions } from './filecoin-pin-store.js'
import type { ServiceInfo } from './index.js'
import { initializeSynapse } from './synapse-service.js'

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      id: string
      name: string
    }
  }
}

const DEFAULT_USER_INFO = {
  id: 'default-user',
  name: 'Default User',
}

export async function createFilecoinPinningServer(
  config: Config,
  logger: Logger,
  serviceInfo: ServiceInfo
): Promise<{ server: FastifyInstance; pinStore: FilecoinPinStore }> {
  // Initialize Synapse
  const synapseService = await initializeSynapse(config, logger)

  // Create our custom Filecoin pin store with Synapse service
  const filecoinPinStore = new FilecoinPinStore({
    config,
    logger,
    synapseService,
  })

  // Set up event handlers for monitoring
  filecoinPinStore.on('pin:block:stored', (data) => {
    logger.debug(
      {
        pinId: data.pinId,
        userId: data.userId,
        cid: data.cid.toString(),
        size: data.size,
      },
      'Block stored for pin'
    )
  })

  filecoinPinStore.on('pin:block:missing', (data) => {
    logger.warn(
      {
        pinId: data.pinId,
        userId: data.userId,
        cid: data.cid.toString(),
      },
      'Block missing for pin'
    )
  })

  filecoinPinStore.on('pin:car:completed', (data) => {
    logger.info(
      {
        pinId: data.pinId,
        userId: data.userId,
        cid: data.cid.toString(),
        blocksWritten: data.stats.blocksWritten,
        totalSize: data.stats.totalSize,
        missingBlocks: data.stats.missingBlocks.size,
        carFilePath: data.carFilePath,
      },
      'CAR file completed for pin'
    )
  })

  filecoinPinStore.on('pin:failed', (data) => {
    logger.error(
      {
        pinId: data.pinId,
        userId: data.userId,
        cid: data.cid.toString(),
        error: data.error,
      },
      'Pin operation failed'
    )
  })

  // Create a custom Fastify server
  const server = fastify({
    logger: false, // We'll use our own logger
  })

  // Add root route for health check (no auth required)
  server.get('/', async (_request, reply) => {
    await reply.send({
      service: serviceInfo.service,
      version: serviceInfo.version,
      status: 'ok',
    })
  })

  // Add authentication hook
  server.addHook('preHandler', async (request, reply) => {
    // Skip auth for root health check
    if (request.url === '/') {
      return
    }

    const authHeader = request.headers.authorization
    if (authHeader?.startsWith('Bearer ') !== true) {
      await reply.code(401).send({ error: 'Missing or invalid authorization header' })
      return
    }

    const token = authHeader.slice(7) // Remove 'Bearer ' prefix
    if (token.trim().length === 0) {
      await reply.code(401).send({ error: 'Invalid access token' })
      return
    }

    // Add user to request context
    request.user = DEFAULT_USER_INFO
  })

  // Add our custom pin store to the Fastify context
  server.decorate('pinStore', filecoinPinStore)

  // Register custom routes that use our pin store
  await server.register(async (fastify) => {
    // Override the default routes with our custom implementations
    await registerCustomPinRoutes(fastify, filecoinPinStore, logger)
  })

  await filecoinPinStore.start()

  // Start listening
  await server.listen({
    port: config.port ?? 0, // Use random port for testing
    host: config.host,
  })

  logger.info('Filecoin pinning service API server started')

  return {
    server,
    pinStore: filecoinPinStore,
  }
}

async function registerCustomPinRoutes(
  fastify: FastifyInstance,
  pinStore: FilecoinPinStore,
  logger: Logger
): Promise<void> {
  // POST /pins - Create a new pin
  fastify.post(
    '/pins',
    async (
      request: FastifyRequest<{
        Body: { cid?: string; name?: string; origins?: string[]; meta?: Record<string, string> }
      }>,
      reply
    ) => {
      try {
        const { cid, name, origins, meta } = request.body
        if (cid == null) {
          await reply.code(400).send({ error: 'Missing required field: cid' })
          return
        }

        // Parse the CID string to CID object
        let cidObject: CID
        try {
          cidObject = CID.parse(cid)
        } catch (_error) {
          await reply.code(400).send({ error: `Invalid CID format: ${cid}` })
          return
        }

        const pinOptions: PinOptions = {}
        if (name != null) pinOptions.name = name
        if (origins != null) pinOptions.origins = origins
        if (meta != null) pinOptions.meta = meta
        if (request.user == null) {
          await reply.code(401).send({ error: 'Unauthorized' })
          return
        }
        const result = await pinStore.pin(request.user, cidObject, pinOptions)

        await reply.code(202).send({
          requestid: result.id,
          status: result.status,
          created: new Date(result.created).toISOString(),
          pin: result.pin,
          delegates: [],
          info: result.info,
        })
      } catch (error) {
        logger.error({ error }, 'Failed to create pin')
        await reply.code(500).send({ error: 'Internal server error' })
      }
    }
  )

  // GET /pins/:requestId - Get pin status
  fastify.get('/pins/:requestId', async (request: FastifyRequest<{ Params: { requestId: string } }>, reply) => {
    try {
      if (request.user == null) {
        await reply.code(401).send({ error: 'Unauthorized' })
        return
      }
      const result = await pinStore.get(request.user, request.params.requestId)
      if (result == null) {
        await reply.code(404).send({ error: 'Pin not found' })
        return
      }

      await reply.send({
        requestid: result.id,
        status: result.status,
        created: new Date(result.created).toISOString(),
        pin: result.pin,
        delegates: [],
        info: result.info,
      })
    } catch (error) {
      logger.error({ error }, 'Failed to get pin status')
      await reply.code(500).send({ error: 'Internal server error' })
    }
  })

  // GET /pins - List pins
  fastify.get(
    '/pins',
    async (
      request: FastifyRequest<{ Querystring: { cid?: string; name?: string; status?: string; limit?: string } }>,
      reply
    ) => {
      try {
        const { cid, name, status, limit } = request.query
        const limitNum = limit != null ? parseInt(limit, 10) : undefined
        const listQuery: Parameters<typeof pinStore.list>[1] = {}
        if (cid != null) listQuery.cid = cid
        if (name != null) listQuery.name = name
        if (status != null) listQuery.status = status
        if (limitNum != null && !Number.isNaN(limitNum)) listQuery.limit = limitNum

        if (request.user == null) {
          await reply.code(401).send({ error: 'Unauthorized' })
          return
        }
        const result = await pinStore.list(request.user, listQuery)

        const results = result.results.map((pin) => ({
          requestid: pin.id,
          status: pin.status,
          created: new Date(pin.created).toISOString(),
          pin: pin.pin,
          delegates: [],
          info: pin.info,
        }))

        await reply.send({
          count: result.count,
          results,
        })
      } catch (error) {
        logger.error({ error }, 'Failed to list pins')
        await reply.code(500).send({ error: 'Internal server error' })
      }
    }
  )

  // POST /pins/:requestId - Update pin (not commonly used)
  fastify.post('/pins/:requestId', async (request: any, reply: any) => {
    try {
      const { name, origins, meta } = request.body
      const result = await pinStore.update(request.user, request.params.requestId, { name, origins, meta })

      if (result == null) {
        await reply.code(404).send({ error: 'Pin not found' })
        return
      }

      await reply.send({
        requestid: result.id,
        status: result.status,
        created: new Date(result.created).toISOString(),
        pin: result.pin,
        delegates: [],
        info: result.info,
      })
    } catch (error) {
      logger.error({ error }, 'Failed to update pin')
      await reply.code(500).send({ error: 'Internal server error' })
    }
  })

  // DELETE /pins/:requestId - Cancel/delete pin and clean up CAR file
  fastify.delete('/pins/:requestId', async (request: any, reply: any) => {
    try {
      await pinStore.cancel(request.user, request.params.requestId)
      await reply.code(202).send()
    } catch (error) {
      logger.error({ error }, 'Failed to cancel pin')
      await reply.code(500).send({ error: 'Internal server error' })
    }
  })
}
