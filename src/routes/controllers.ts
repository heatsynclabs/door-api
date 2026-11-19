// The REST surface. Everything is scoped to a controller by id, so the same API
// serves one board or several of different kinds. Every hardware call goes
// through controller.run() (per-controller queue + circuit breaker), and every
// action that changes something is written to the audit trail.
//
// Scopes: readonly = status and reads; door = also door actions and the alarm;
// full = also cards and the event log.
import { Type } from '@sinclair/typebox'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { FastifyRequest } from 'fastify'
import type { Registry, Controller } from '../registry.js'
import type { RequireFn } from '../auth.js'
import type { DoorAction } from '../config.js'
import type { Audit, AuditRecord } from '../audit.js'
import type { Journal, DrainEntry } from '../journal.js'
import { CardSchema, ControllerStatusSchema, DoorEventSchema } from '../domain.js'
import { ActionNotAllowed, DoorApiError, DoorJobsOff, NotFound, NotSupported } from '../errors.js'
import { reconcileCards } from '../reconcile.js'

export interface RouteDeps {
  registry: Registry
  require: RequireFn
  // false on a second copy (staging): see doorJobsEnabled in config.ts
  doorJobs: boolean
  audit: Audit
  journal: Journal
  // open and unlock that cannot start within this many ms are dropped (Busy)
  doorActionDeadline: number
}

const IdParams = Type.Object({ id: Type.String() })
const DoorParams = Type.Object({ id: Type.String(), door: Type.Integer({ minimum: 1, maximum: 4 }) })
const SlotParams = Type.Object({ id: Type.String(), slot: Type.Integer({ minimum: 0, maximum: 199 }) })
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
const PutSlotBody = Type.Object(
  {
    tag: Type.String({ pattern: '^[0-9A-Fa-f]{1,8}$', description: 'Card number in hex, as the members site stores it.' }),
    mask: Type.Integer({ minimum: 0, maximum: 255, description: 'Board permission mask: 1 enabled, 255 disabled.' })
  },
  { additionalProperties: false }
)
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
const SlotEntrySchema = Type.Object({
  slot: Type.Integer(),
  mask: Type.Integer(),
  tag: Type.Union([Type.String(), Type.Null()]),
  empty: Type.Boolean()
})
const SlotChangeSchema = Type.Object({
  ok: Type.Boolean(),
  slot: Type.Integer(),
  prev: Type.Union([SlotEntrySchema, Type.Null()]),
  cur: Type.Union([SlotEntrySchema, Type.Null()])
})
const DrainSchema = Type.Object({
  drain_id: Type.String(),
  taken_at: Type.String(),
  raw: Type.String(),
  cleared: Type.Boolean()
})
const AckBody = Type.Object({ drain_id: Type.String({ maxLength: 64 }) }, { additionalProperties: false })
const Ack = Type.Object({ ok: Type.Boolean(), message: Type.String() })
const ControllerSummary = Type.Object({ id: Type.String(), driver: Type.String(), doors: Type.Array(Type.Integer()) })

// X-Door-Actor is informational (the caller sets it): keep it short and printable.
function actorOf(request: FastifyRequest): string | undefined {
  const raw = request.headers['x-door-actor']
  const v = Array.isArray(raw) ? raw[0] : raw
  if (!v) return undefined
  return v.replace(/[^\x20-\x7e]/g, '').slice(0, 100)
}

export const controllerRoutes: FastifyPluginAsyncTypebox<RouteDeps> = async (app, opts) => {
  const { registry, require, doorJobs, audit, journal, doorActionDeadline } = opts

  const lookup = (id: string): Controller => {
    const controller = registry.get(id)
    if (!controller) throw new NotFound(`no controller "${id}"`)
    return controller
  }

  // With DOOR_JOBS=off a real board only takes status and door actions (open,
  // unlock, lock). The event log, the alarm and every card read or write are
  // refused there, because the production system owns them. Sandbox controllers
  // allow everything.
  const lookupForJob = (id: string): Controller => {
    const controller = lookup(id)
    if (!doorJobs && !controller.sandbox) throw new DoorJobsOff()
    return controller
  }

  // Run an action and write it to the audit trail, whatever the outcome.
  async function audited<T>(
    request: FastifyRequest,
    base: Omit<AuditRecord, 'key' | 'actor' | 'result'>,
    fn: () => Promise<T>
  ): Promise<T> {
    const who = { key: request.apiKey?.name ?? 'unknown', actor: actorOf(request) }
    try {
      const out = await fn()
      await audit.record({ ...who, ...base, result: 'ok' })
      return out
    } catch (err) {
      const refused = err instanceof DoorApiError && err.statusCode < 500
      await audit.record({ ...who, ...base, result: refused ? 'refused' : 'error', error: (err as Error).message })
      throw err
    }
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
      const status = await controller.run(() => controller.adapter.status())
      const paused = controller.adapter.authPausedUntil?.() ?? null
      return { ...status, circuit: controller.circuitState(), auth_paused_until: paused ? new Date(paused).toISOString() : null }
    }
  )

  // ---- doors ----

  const deadlineFor = (action: DoorAction): number | undefined =>
    action === 'lock' ? undefined : doorActionDeadline // a late lock is safe; a late open is not

  for (const action of ['unlock', 'lock', 'open'] as const) {
    app.post(
      `/controllers/:id/doors/:door/${action}`,
      {
        preHandler: require('door'),
        schema: {
          summary: `${action[0]!.toUpperCase()}${action.slice(1)} one door`,
          tags: ['doors'],
          params: DoorParams,
          response: { 200: Ack }
        }
      },
      async (request) => {
        const controller = lookup(request.params.id)
        const door = request.params.door
        return audited(request, { controller: controller.id, action, door }, async () => {
          if (!controller.allows(door, action)) throw new ActionNotAllowed(`door ${door} does not take "${action}" here`)
          await controller.run(() => controller.adapter[action](door), { deadlineMs: deadlineFor(action) })
          return { ok: true, message: `door ${door} ${action}` }
        })
      }
    )
  }

  // Whole-board lock and unlock. On the Open Access board these are its own
  // commands (?l, ?u): lock-all does not chirp the alarm strobe, which matters
  // for the after-hours lock that runs every 15 minutes at night.
  for (const action of ['unlock', 'lock'] as const) {
    app.post(
      `/controllers/:id/doors/${action}`,
      {
        preHandler: require('door'),
        schema: { summary: `${action[0]!.toUpperCase()}${action.slice(1)} every door`, tags: ['doors'], params: IdParams, response: { 200: Ack } }
      },
      async (request) => {
        const controller = lookup(request.params.id)
        const { adapter } = controller
        return audited(request, { controller: controller.id, action: `${action}_all` }, async () => {
          const refused = adapter.doors.filter((d) => !controller.allows(d, action))
          if (refused.length) throw new ActionNotAllowed(`door ${refused.join(', ')} does not take "${action}" here`)
          const whole = action === 'lock' ? adapter.lockAll?.bind(adapter) : adapter.unlockAll?.bind(adapter)
          await controller.run(
            async () => {
              if (whole) return whole()
              for (const d of adapter.doors) await adapter[action](d)
            },
            { deadlineMs: deadlineFor(action) }
          )
          return { ok: true, message: `all doors ${action}` }
        })
      }
    )
  }

  // ---- alarm ----

  for (const action of ['arm', 'disarm'] as const) {
    app.post(
      `/controllers/:id/alarm/${action}`,
      {
        preHandler: require('door'),
        schema: { summary: `${action[0]!.toUpperCase()}${action.slice(1)} the alarm`, tags: ['alarm'], params: IdParams, response: { 200: Ack } }
      },
      async (request) => {
        const controller = lookupForJob(request.params.id)
        const fn = controller.adapter[action]?.bind(controller.adapter)
        if (!fn) throw new NotSupported(`controller "${controller.id}" has no alarm`)
        return audited(request, { controller: controller.id, action }, async () => {
          await controller.run(() => fn())
          return { ok: true, message: `alarm ${action}ed` }
        })
      }
    )
  }

  // ---- slots (boards that key cards by slot: the Open Access Arduino) ----

  app.get(
    '/controllers/:id/slots',
    {
      preHandler: require('readonly'),
      schema: {
        summary: 'Read every slot',
        tags: ['slots'],
        params: IdParams,
        response: { 200: Type.Object({ masked: Type.Boolean(), slots: Type.Array(SlotEntrySchema) }) }
      }
    },
    async (request) => {
      const controller = lookupForJob(request.params.id)
      const fn = controller.adapter.listSlots?.bind(controller.adapter)
      if (!fn) throw new NotSupported(`controller "${controller.id}" has no slots`)
      return controller.run(() => fn())
    }
  )

  app.put(
    '/controllers/:id/slots/:slot',
    {
      preHandler: require('full'),
      schema: {
        summary: 'Write one slot (tag and mask), as the members site assigns them',
        tags: ['slots'],
        params: SlotParams,
        body: PutSlotBody,
        response: { 200: SlotChangeSchema }
      }
    },
    async (request) => {
      const controller = lookupForJob(request.params.id)
      const fn = controller.adapter.writeSlot?.bind(controller.adapter)
      if (!fn) throw new NotSupported(`controller "${controller.id}" has no slots`)
      const { slot } = request.params
      return audited(request, { controller: controller.id, action: `write_slot mask ${request.body.mask}`, slot }, async () => {
        const change = await controller.run(() => fn(slot, request.body.mask, request.body.tag))
        return { ok: true, ...change }
      })
    }
  )

  app.delete(
    '/controllers/:id/slots/:slot',
    {
      preHandler: require('full'),
      schema: { summary: 'Clear one slot', tags: ['slots'], params: SlotParams, response: { 200: SlotChangeSchema } }
    },
    async (request) => {
      const controller = lookupForJob(request.params.id)
      const fn = controller.adapter.clearSlot?.bind(controller.adapter)
      if (!fn) throw new NotSupported(`controller "${controller.id}" has no slots`)
      const { slot } = request.params
      return audited(request, { controller: controller.id, action: 'clear_slot', slot }, async () => {
        const change = await controller.run(() => fn(slot))
        return { ok: true, ...change }
      })
    }
  )

  // ---- event log: drain and acknowledge ----

  app.post(
    '/controllers/:id/log/drain',
    {
      preHandler: require('full'),
      schema: {
        summary: 'Read and clear the board event log, journaled until acknowledged',
        description:
          'In one queued step: read the buffer, write it to the journal on disk, clear the board. Returns every unacknowledged drain, oldest first (earlier ones too). Save the rows, then POST log/ack for each drain_id.',
        tags: ['log'],
        params: IdParams,
        response: { 200: Type.Object({ drains: Type.Array(DrainSchema) }) }
      }
    },
    async (request) => {
      const controller = lookupForJob(request.params.id)
      const { adapter } = controller
      if (!adapter.readLog || !adapter.clearLog) throw new NotSupported(`controller "${controller.id}" has no event buffer`)
      if (!journal.durable && !controller.sandbox) {
        throw new DoorApiError(500, 'JOURNAL_DIR is not set; refusing to clear a real board log without a journal', 'no_journal')
      }
      await audited(request, { controller: controller.id, action: 'log_drain' }, () =>
        controller.run(async () => {
          const entry: DrainEntry = {
            drain_id: journal.newId(),
            controller: controller.id,
            taken_at: new Date().toISOString(),
            raw: await adapter.readLog!(),
            cleared: false
          }
          await journal.write(entry) // on disk before the board is cleared
          try {
            await adapter.clearLog!()
            entry.cleared = true
            await journal.write(entry)
          } catch (err) {
            // Kept: losing events is worse than a repeated row. The board may
            // still hold them, so the next drain can return them again.
            request.log.warn({ err: (err as Error).message, drain: entry.drain_id }, 'board log read but not cleared')
          }
        })
      )
      const drains = await journal.pending(controller.id)
      return { drains: drains.map(({ drain_id, taken_at, raw, cleared }) => ({ drain_id, taken_at, raw, cleared })) }
    }
  )

  app.post(
    '/controllers/:id/log/ack',
    {
      preHandler: require('full'),
      schema: { summary: 'Forget a drain once its rows are saved', tags: ['log'], params: IdParams, body: AckBody, response: { 200: Ack } }
    },
    async (request) => {
      const controller = lookupForJob(request.params.id)
      const done = await journal.ack(controller.id, request.body.drain_id)
      if (!done) throw new NotFound(`no pending drain "${request.body.drain_id}"`)
      return { ok: true, message: `drain ${request.body.drain_id} acknowledged` }
    }
  )

  app.get(
    '/controllers/:id/log/pending',
    {
      preHandler: require('readonly'),
      schema: {
        summary: 'Unacknowledged drains (should be empty between imports)',
        tags: ['log'],
        params: IdParams,
        response: { 200: Type.Object({ pending: Type.Array(Type.Object({ drain_id: Type.String(), taken_at: Type.String(), cleared: Type.Boolean() })) }) }
      }
    },
    async (request) => {
      const controller = lookup(request.params.id)
      const drains = await journal.pending(controller.id)
      return { pending: drains.map(({ drain_id, taken_at, cleared }) => ({ drain_id, taken_at, cleared })) }
    }
  )

  // ---- card-number API (UHPPOTE, memory; an Open Access board needs unmasked tags) ----

  app.get(
    '/controllers/:id/cards',
    {
      preHandler: require('readonly'),
      schema: { summary: 'List cards on a controller', tags: ['cards'], params: IdParams, response: { 200: Type.Array(CardSchema) } }
    },
    async (request) => {
      const controller = lookupForJob(request.params.id)
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
      const controller = lookupForJob(request.params.id)
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
      const controller = lookupForJob(request.params.id)
      const body = request.body
      return audited(request, { controller: controller.id, action: `put_card ${request.params.card}` }, async () => {
        await controller.run(() =>
          controller.adapter.putCard({ card: request.params.card, doors: body.doors, from: body.from, to: body.to })
        )
        return { ok: true, message: `card ${request.params.card} written` }
      })
    }
  )

  app.delete(
    '/controllers/:id/cards/:card',
    {
      preHandler: require('full'),
      schema: { summary: 'Remove a card', tags: ['cards'], params: CardParams, response: { 200: Ack } }
    },
    async (request) => {
      const controller = lookupForJob(request.params.id)
      return audited(request, { controller: controller.id, action: `delete_card ${request.params.card}` }, async () => {
        await controller.run(() => controller.adapter.deleteCard(request.params.card))
        return { ok: true, message: `card ${request.params.card} removed` }
      })
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
      const controller = lookupForJob(request.params.id)
      const { cards, prune } = request.body
      return audited(request, { controller: controller.id, action: `sync ${cards.length} cards` }, () =>
        controller.run(() => reconcileCards(controller.adapter, cards, prune ?? false))
      )
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
      const controller = lookupForJob(request.params.id)
      const after = request.query.after ?? 0
      const limit = request.query.limit ?? 100
      return controller.run(() => controller.adapter.events(after, limit))
    }
  )
}
