// Builds the Fastify app. buildServer is pure (takes config, optionally injected
// adapters) so tests can drive it with fakes via app.inject() and no network.
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import type { FastifyBaseLogger } from 'fastify'
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { Config } from './config.js'
import type { ControllerAdapter } from './domain.js'
import { Registry } from './registry.js'
import { makeRequire } from './auth.js'
import { DoorApiError } from './errors.js'
import { controllerRoutes } from './routes/controllers.js'
import { healthRoutes } from './routes/health.js'

export const VERSION = '0.1.0'

export interface BuildOptions {
  config: Config
  adapters?: ControllerAdapter[] // inject fakes for tests
}

function loggerOptions(config: Config): FastifyBaseLogger | boolean | object {
  if (config.env === 'test') return false
  if (config.env === 'development') {
    return { level: config.logLevel, transport: { target: 'pino-pretty' } }
  }
  return { level: config.logLevel }
}

export async function buildServer(options: BuildOptions): Promise<FastifyInstance> {
  const { config } = options

  const app = Fastify({
    logger: loggerOptions(config) as never,
    requestTimeout: config.timeouts.server
  }).withTypeProvider<TypeBoxTypeProvider>()

  const registry = new Registry(config, options.adapters)
  const requireFn = makeRequire(config.apiKeys)

  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof DoorApiError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message })
    }
    // Fastify/ajv validation errors
    if (err.validation) {
      return reply.code(400).send({ error: 'bad_request', message: err.message })
    }
    request.log.error({ err }, 'unhandled error')
    return reply.code(500).send({ error: 'internal_error', message: 'unexpected error' })
  })

  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' })

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'HeatSync Door API',
        version: VERSION,
        description:
          'One REST API over different door controllers (UHPPOTE/UT0311 and the legacy Open Access Arduino) behind a driver adapter layer.'
      },
      components: {
        securitySchemes: { apiKey: { type: 'http', scheme: 'bearer' } }
      },
      security: [{ apiKey: [] }]
    }
  })
  await app.register(swaggerUi, { routePrefix: '/docs' })

  await app.register(healthRoutes, { registry, version: VERSION })
  await app.register(controllerRoutes, { registry, require: requireFn, prefix: '/v1' })

  return app
}
