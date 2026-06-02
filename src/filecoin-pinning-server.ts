import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { CID } from 'multiformats/cid'
import type { Logger } from 'pino'
import { isAddress, isHex } from 'viem'
import type { Chain, Config } from './core/synapse/index.js'
import { initializeSynapse, type SynapseSetupConfig } from './core/synapse/index.js'
import { FilecoinPinStore } from './filecoin-pin-store.js'
import type { ServiceInfo } from './server.js'

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

/**
 * Send an error response in the IPFS Pinning Service API error shape:
 * `{ error: { reason, details } }`. See https://ipfs.github.io/pinning-services-api-spec/.
 */
async function sendError(reply: FastifyReply, statusCode: number, reason: string, details?: string): Promise<void> {
  const error: { reason: string; details?: string } = { reason }
  if (details != null) {
    error.details = details
  }
  await reply.code(statusCode).send({ error })
}

interface PinMutationBody {
  name?: string
  origins?: string[]
  meta?: Record<string, string>
}

/**
 * Validate the optional `name` / `origins` / `meta` fields shared by the create and update
 * pin endpoints. Returns the validated options, or an error message describing what is malformed.
 */
function parsePinMutationBody(body: unknown): { options: PinMutationBody } | { error: string } {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' }
  }

  const { name, origins, meta } = body as Record<string, unknown>
  const options: PinMutationBody = {}

  if (name !== undefined) {
    if (typeof name !== 'string') {
      return { error: 'Field "name" must be a string' }
    }
    options.name = name
  }

  if (origins !== undefined) {
    if (!Array.isArray(origins) || origins.some((origin) => typeof origin !== 'string')) {
      return { error: 'Field "origins" must be an array of strings' }
    }
    options.origins = origins as string[]
  }

  if (meta !== undefined) {
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
      return { error: 'Field "meta" must be an object of string values' }
    }
    if (Object.values(meta).some((value) => typeof value !== 'string')) {
      return { error: 'Field "meta" must be an object of string values' }
    }
    options.meta = meta as Record<string, string>
  }

  return { options }
}

function buildSynapseConfig(config: Config): SynapseSetupConfig {
  const base: { rpcUrl: string; chain?: Chain } = { rpcUrl: config.rpcUrl }
  if (config.chain) {
    base.chain = config.chain
  }

  if (config.walletAddress && config.sessionKey) {
    if (!isAddress(config.walletAddress)) {
      throw new Error('Wallet address must be an ethereum address')
    }
    if (!isHex(config.sessionKey)) {
      throw new Error('Session key must be 0x-prefixed hexadecimal')
    }
    if (config.sessionKey.length !== 66) {
      throw new Error('Session key must be 32 bytes')
    }
    return {
      ...base,
      walletAddress: config.walletAddress,
      sessionKey: config.sessionKey,
    }
  }

  if (config.privateKey) {
    if (!isHex(config.privateKey)) {
      throw new Error('Private key must be 0x-prefixed hexadecimal')
    }
    if (config.privateKey.length !== 66) {
      throw new Error('Private key must be 32 bytes')
    }
    return { ...base, privateKey: config.privateKey }
  }

  throw new Error(
    'No authentication configured. Provide a private key (--private-key / PRIVATE_KEY) ' +
      'or session key (--wallet-address + --session-key / WALLET_ADDRESS + SESSION_KEY).'
  )
}

export async function createFilecoinPinningServer(
  config: Config,
  logger: Logger,
  serviceInfo: ServiceInfo
): Promise<{ server: FastifyInstance; pinStore: FilecoinPinStore }> {
  // Set up Synapse service
  const synapseConfig = buildSynapseConfig(config)

  // Refuse to start open to the world by accident: require an access token unless the operator
  // explicitly opts out with --allow-no-auth / ALLOW_NO_AUTH. Checked before the network call below.
  if (!config.accessToken && config.allowNoAuth !== true) {
    throw new Error(
      'No access token configured. Set an access token (--access-token / ACCESS_TOKEN) to require ' +
        'authentication, or pass --allow-no-auth to run the server open to all requests (not recommended).'
    )
  }

  const synapse = await initializeSynapse(synapseConfig, logger)

  const filecoinPinStore = new FilecoinPinStore({
    config,
    logger,
    synapse,
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

    // No access token means the operator started with --allow-no-auth: serve all requests.
    if (!config.accessToken) {
      request.user = DEFAULT_USER_INFO
      return
    }

    const authHeader = request.headers.authorization
    if (authHeader?.startsWith('Bearer ') !== true) {
      await sendError(reply, 401, 'UNAUTHORIZED', 'Missing or invalid authorization header')
      return
    }

    const token = authHeader.slice(7).trim() // Remove 'Bearer ' prefix
    if (token.length === 0) {
      await sendError(reply, 401, 'UNAUTHORIZED', 'Invalid access token')
      return
    }

    if (token !== config.accessToken) {
      await sendError(reply, 403, 'FORBIDDEN', 'Invalid access token')
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
  fastify.post('/pins', async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    try {
      if (request.user == null) {
        await sendError(reply, 401, 'UNAUTHORIZED', 'Unauthorized')
        return
      }

      const body = request.body
      if (body == null || typeof body !== 'object' || Array.isArray(body)) {
        await sendError(reply, 400, 'BAD_REQUEST', 'Request body must be a JSON object')
        return
      }

      const { cid } = body as Record<string, unknown>
      if (cid == null) {
        await sendError(reply, 400, 'BAD_REQUEST', 'Missing required field: cid')
        return
      }
      if (typeof cid !== 'string') {
        await sendError(reply, 400, 'BAD_REQUEST', 'Field "cid" must be a string')
        return
      }

      const parsed = parsePinMutationBody(body)
      if ('error' in parsed) {
        await sendError(reply, 400, 'BAD_REQUEST', parsed.error)
        return
      }

      // Parse the CID string to CID object
      let cidObject: CID
      try {
        cidObject = CID.parse(cid)
      } catch (_error) {
        await sendError(reply, 400, 'BAD_REQUEST', `Invalid CID format: ${cid}`)
        return
      }

      const result = await pinStore.pin(request.user, cidObject, parsed.options)

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
      await sendError(reply, 500, 'INTERNAL_ERROR', 'Internal server error')
    }
  })

  // GET /pins/:requestId - Get pin status
  fastify.get('/pins/:requestId', async (request: FastifyRequest<{ Params: { requestId: string } }>, reply) => {
    try {
      if (request.user == null) {
        await sendError(reply, 401, 'UNAUTHORIZED', 'Unauthorized')
        return
      }
      const result = await pinStore.get(request.user, request.params.requestId)
      if (result == null) {
        await sendError(reply, 404, 'NOT_FOUND', 'Pin not found')
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
      await sendError(reply, 500, 'INTERNAL_ERROR', 'Internal server error')
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
          await sendError(reply, 401, 'UNAUTHORIZED', 'Unauthorized')
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
        await sendError(reply, 500, 'INTERNAL_ERROR', 'Internal server error')
      }
    }
  )

  // POST /pins/:requestId - Update pin (not commonly used)
  fastify.post(
    '/pins/:requestId',
    async (request: FastifyRequest<{ Params: { requestId: string }; Body: unknown }>, reply) => {
      try {
        if (request.user == null) {
          await sendError(reply, 401, 'UNAUTHORIZED', 'Unauthorized')
          return
        }

        const parsed = parsePinMutationBody(request.body)
        if ('error' in parsed) {
          await sendError(reply, 400, 'BAD_REQUEST', parsed.error)
          return
        }

        const result = await pinStore.update(request.user, request.params.requestId, parsed.options)
        if (result == null) {
          await sendError(reply, 404, 'NOT_FOUND', 'Pin not found')
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
        await sendError(reply, 500, 'INTERNAL_ERROR', 'Internal server error')
      }
    }
  )

  // DELETE /pins/:requestId - Cancel/delete pin and clean up CAR file
  fastify.delete('/pins/:requestId', async (request: FastifyRequest<{ Params: { requestId: string } }>, reply) => {
    try {
      if (request.user == null) {
        await sendError(reply, 401, 'UNAUTHORIZED', 'Unauthorized')
        return
      }
      await pinStore.cancel(request.user, request.params.requestId)
      await reply.code(202).send()
    } catch (error) {
      logger.error({ error }, 'Failed to cancel pin')
      await sendError(reply, 500, 'INTERNAL_ERROR', 'Internal server error')
    }
  })
}
