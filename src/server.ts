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
import { Audit } from './audit.js'
import { Journal } from './journal.js'
import { controllerRoutes } from './routes/controllers.js'
import { healthRoutes } from './routes/health.js'

export const VERSION = '0.2.0'

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

  // Door/action POSTs carry no body. Some HTTP clients tag a bodyless POST with a
  // default form content-type; accept it (ignore the body) instead of 415.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, _body, done) => {
    done(null, undefined)
  })

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
    // Fastify's own client errors (429 rate limit, 413 too large, 400 bad JSON)
    if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.code ?? 'client_error', message: err.message })
    }
    request.log.error({ err }, 'unhandled error')
    return reply.code(500).send({ error: 'internal_error', message: 'unexpected error' })
  })

  // Per client address. Errors keep their own status (429, 400, 413), never 500.
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' })

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

  if (!config.doorJobs) {
    app.log.warn('DOOR_JOBS=off: event log reads, card sync and health polling are limited to sandbox controllers')
  }
  const audit = new Audit(config.auditFile, app.log)
  const journal = new Journal(config.journalDir)
  await app.register(healthRoutes, { registry, require: requireFn, version: VERSION, doorJobs: config.doorJobs })
  await app.register(controllerRoutes, {
    registry,
    require: requireFn,
    doorJobs: config.doorJobs,
    audit,
    journal,
    doorActionDeadline: config.timeouts.doorActionDeadline,
    prefix: '/v1'
  })

  return app
}
