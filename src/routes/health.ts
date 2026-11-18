// Liveness + per-controller reachability and circuit state. No auth: monitoring
// needs to reach it. Returns 503 if any controller is unreachable.
import { Type } from '@sinclair/typebox'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { Registry } from '../registry.js'

export interface HealthDeps {
  registry: Registry
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
  const { registry, version, doorJobs } = opts

  app.get(
    '/health',
    {
      schema: {
        summary: 'Health check',
        tags: ['health'],
        response: {
          200: Type.Object({
            status: Type.String(),
            version: Type.String(),
            uptime: Type.Number(),
            doorJobs: Type.Boolean(),
            controllers: Type.Array(ControllerHealth)
          }),
          503: Type.Object({
            status: Type.String(),
            version: Type.String(),
            uptime: Type.Number(),
            doorJobs: Type.Boolean(),
            controllers: Type.Array(ControllerHealth)
          })
        }
      }
    },
    async (_request, reply) => {
      const controllers = await Promise.all(
        registry.all().map(async (controller) => {
          const { adapter } = controller
          const circuit = controller.circuitState()
          // Monitoring calls this every 30 seconds: on a second copy that would
          // be a polling job against a real board, so only sandboxes are polled.
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
      return reply
        .code(healthy ? 200 : 503)
        .send({ status: healthy ? 'healthy' : 'degraded', version, uptime: process.uptime(), doorJobs, controllers })
    }
  )
}
