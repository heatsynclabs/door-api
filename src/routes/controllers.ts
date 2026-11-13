// The REST surface. Everything is scoped to a controller by id, so the same API
// serves one board or several of different kinds. Readonly keys can read status,
// cards and events; full keys can open doors and write cards. Every hardware call
// goes through controller.run() (per-controller serialization + circuit breaker).
import { Type } from '@sinclair/typebox'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { Registry } from '../registry.js'
import type { RequireFn } from '../auth.js'
import { CardSchema, ControllerStatusSchema, DoorEventSchema } from '../domain.js'
import { NotFound } from '../errors.js'
import { reconcileCards } from '../reconcile.js'

export interface RouteDeps {
  registry: Registry
  require: RequireFn
}

const IdParams = Type.Object({ id: Type.String() })
const DoorParams = Type.Object({ id: Type.String(), door: Type.Integer({ minimum: 1, maximum: 4 }) })
const CardParams = Type.Object({ id: Type.String(), card: Type.Integer({ minimum: 1 }) })
const EventsQuery = Type.Object({
  after: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 100 }))
})
const PutCardBody = Type.Object({
  doors: Type.Array(Type.Integer({ minimum: 1, maximum: 4 })),
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String())
})
const SyncBody = Type.Object({
  cards: Type.Array(CardSchema),
  prune: Type.Optional(Type.Boolean({ default: false, description: 'Remove cards on the board that are not in the set.' }))
})
const SyncResultSchema = Type.Object({
  added: Type.Integer(),
  updated: Type.Integer(),
  unchanged: Type.Integer(),
  removed: Type.Integer(),
  failed: Type.Array(Type.Object({ card: Type.Integer(), error: Type.String() }))
})
const Ack = Type.Object({ ok: Type.Boolean(), message: Type.String() })
const ControllerSummary = Type.Object({ id: Type.String(), driver: Type.String(), doors: Type.Array(Type.Integer()) })

export const controllerRoutes: FastifyPluginAsyncTypebox<RouteDeps> = async (app, opts) => {
  const { registry, require } = opts

  const lookup = (id: string) => {
    const controller = registry.get(id)
    if (!controller) throw new NotFound(`no controller "${id}"`)
    return controller
  }

  app.get(
    '/controllers',
    {
      preHandler: require('readonly'),
      schema: { summary: 'List configured controllers', tags: ['controllers'], response: { 200: Type.Array(ControllerSummary) } }
    },
    async () => registry.all().map((c) => ({ id: c.adapter.id, driver: c.adapter.driver, doors: c.adapter.doors }))
  )

  app.get(
    '/controllers/:id/status',
    {
      preHandler: require('readonly'),
      schema: { summary: 'Controller and door status', tags: ['controllers'], params: IdParams, response: { 200: ControllerStatusSchema } }
    },
    async (request) => {
      const controller = lookup(request.params.id)
      return controller.run(() => controller.adapter.status())
    }
  )

  for (const action of ['unlock', 'lock', 'open'] as const) {
    app.post(
      `/controllers/:id/doors/:door/${action}`,
      {
        preHandler: require('full'),
        schema: {
          summary: `${action[0]!.toUpperCase()}${action.slice(1)} a door`,
          tags: ['doors'],
          params: DoorParams,
          response: { 200: Ack }
        }
      },
      async (request) => {
        const controller = lookup(request.params.id)
        const door = request.params.door
        await controller.run(() => controller.adapter[action](door))
        return { ok: true, message: `door ${door} ${action}` }
      }
    )
  }

  app.get(
    '/controllers/:id/cards',
    {
      preHandler: require('readonly'),
      schema: { summary: 'List cards on a controller', tags: ['cards'], params: IdParams, response: { 200: Type.Array(CardSchema) } }
    },
    async (request) => {
      const controller = lookup(request.params.id)
      return controller.run(() => controller.adapter.listCards())
    }
  )

  app.get(
    '/controllers/:id/cards/:card',
    {
      preHandler: require('readonly'),
      schema: { summary: 'Get one card', tags: ['cards'], params: CardParams, response: { 200: CardSchema } }
    },
    async (request) => {
      const controller = lookup(request.params.id)
      const card = await controller.run(() => controller.adapter.getCard(request.params.card))
      if (!card) throw new NotFound(`card ${request.params.card} is not on controller "${request.params.id}"`)
      return card
    }
  )

  app.put(
    '/controllers/:id/cards/:card',
    {
      preHandler: require('full'),
      schema: { summary: 'Create or update a card (idempotent)', tags: ['cards'], params: CardParams, body: PutCardBody, response: { 200: Ack } }
    },
    async (request) => {
      const controller = lookup(request.params.id)
      const body = request.body
      await controller.run(() =>
        controller.adapter.putCard({ card: request.params.card, doors: body.doors, from: body.from, to: body.to })
      )
      return { ok: true, message: `card ${request.params.card} written` }
    }
  )

  app.delete(
    '/controllers/:id/cards/:card',
    {
      preHandler: require('full'),
      schema: { summary: 'Remove a card', tags: ['cards'], params: CardParams, response: { 200: Ack } }
    },
    async (request) => {
      const controller = lookup(request.params.id)
      await controller.run(() => controller.adapter.deleteCard(request.params.card))
      return { ok: true, message: `card ${request.params.card} removed` }
    }
  )

  app.post(
    '/controllers/:id/cards/sync',
    {
      preHandler: require('full'),
      schema: {
        summary: 'Reconcile the board to a desired set of cards',
        tags: ['cards'],
        params: IdParams,
        body: SyncBody,
        response: { 200: SyncResultSchema }
      }
    },
    async (request) => {
      const controller = lookup(request.params.id)
      const { cards, prune } = request.body
      // One serialized batch: read the board once, write only the deltas.
      return controller.run(() => reconcileCards(controller.adapter, cards, prune ?? false))
    }
  )

  app.get(
    '/controllers/:id/events',
    {
      preHandler: require('readonly'),
      schema: {
        summary: 'Read events since an index',
        tags: ['events'],
        params: IdParams,
        querystring: EventsQuery,
        response: { 200: Type.Object({ events: Type.Array(DoorEventSchema), first: Type.Integer(), last: Type.Integer() }) }
      }
    },
    async (request) => {
      const controller = lookup(request.params.id)
      const after = request.query.after ?? 0
      const limit = request.query.limit ?? 100
      return controller.run(() => controller.adapter.events(after, limit))
    }
  )
}
