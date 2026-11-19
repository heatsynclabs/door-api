// /health is liveness only: it never touches a controller, so the container
// healthcheck and monitoring cannot become a polling job against a door board.
// Controller reachability is behind a key at /v1/health/controllers.
import { Type } from '@sinclair/typebox'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { Registry } from '../registry.js'
import type { RequireFn } from '../auth.js'

export interface HealthDeps {
  registry: Registry
  require: RequireFn
  version: string
  doorJobs: boolean
}

const ControllerHealth = Type.Object({
  id: Type.String(),
  driver: Type.String(),
  reachable: Type.Boolean(),
  circuit: Type.String(),
  error: Type.Optional(Type.String()),
  // Set when the controller was not polled (DOOR_JOBS=off and not a sandbox).
  skipped: Type.Optional(Type.String())
})

export const healthRoutes: FastifyPluginAsyncTypebox<HealthDeps> = async (app, opts) => {
  const { registry, require, version, doorJobs } = opts

  app.get(
    '/health',
    {
      schema: {
        summary: 'Liveness (never contacts a controller)',
        tags: ['health'],
        response: { 200: Type.Object({ status: Type.String(), version: Type.String(), uptime: Type.Number(), doorJobs: Type.Boolean() }) }
      }
    },
    async () => ({ status: 'ok', version, uptime: process.uptime(), doorJobs })
  )

  app.get(
    '/v1/health/controllers',
    {
      preHandler: require('readonly'),
      schema: {
        summary: 'Ask each controller for its status',
        tags: ['health'],
        response: {
          200: Type.Object({ status: Type.String(), controllers: Type.Array(ControllerHealth) }),
          503: Type.Object({ status: Type.String(), controllers: Type.Array(ControllerHealth) })
        }
      }
    },
    async (_request, reply) => {
      const controllers = await Promise.all(
        registry.all().map(async (controller) => {
          const { adapter } = controller
          const circuit = controller.circuitState()
          if (!doorJobs && !controller.sandbox) {
            return { id: adapter.id, driver: adapter.driver, reachable: false, circuit, skipped: 'DOOR_JOBS=off' }
          }
          try {
            await controller.run(() => adapter.status())
            return { id: adapter.id, driver: adapter.driver, reachable: true, circuit }
          } catch (err) {
            return { id: adapter.id, driver: adapter.driver, reachable: false, circuit, error: (err as Error).message }
          }
        })
      )
      const healthy = controllers.every((c) => c.reachable || c.skipped)
      return reply.code(healthy ? 200 : 503).send({ status: healthy ? 'healthy' : 'degraded', controllers })
    }
  )
}
