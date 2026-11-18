import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import type { Config, ControllerConfig } from '../src/config.js'
import { MemoryAdapter } from '../src/adapters/memory.js'
import type { DriverName } from '../src/domain.js'

// A stand-in for a real board: behaves like memory but reports another driver,
// and counts how often it is asked for its status.
class RealBoard extends MemoryAdapter {
  override readonly driver: DriverName = 'openaccess'
  statusCalls = 0
  override async status() {
    this.statusCalls += 1
    return super.status()
  }
}

function controller(id: string, extra: Partial<ControllerConfig> = {}): ControllerConfig {
  return { id, driver: 'openaccess', url: 'http://192.0.2.1', password: '1234', doors: [1, 2], ...extra }
}

function config(doorJobs: boolean): Config {
  return {
    host: '127.0.0.1',
    port: 0,
    env: 'test',
    logLevel: 'silent',
    doorJobs,
    apiKeys: new Map([['full', 'full']]),
    controllers: [controller('real'), controller('sim', { sandbox: true }), { id: 'bench', driver: 'memory', doors: [1, 2] }],
    timeouts: { hardware: 1000, server: 5000 },
    circuit: { enabled: false, errorThresholdPercentage: 50, resetTimeout: 1000, volumeThreshold: 5 },
    uhppote: { bind: '0.0.0.0', broadcast: '255.255.255.255:60000', listen: '0.0.0.0:60001' }
  }
}

const FULL = { authorization: 'Bearer full' }
const SYNC = { cards: [{ card: 1234567, doors: [1] }] }

describe('DOOR_JOBS=off (a staging copy)', () => {
  let app: FastifyInstance
  let real: RealBoard

  beforeAll(async () => {
    real = new RealBoard(controller('real'))
    const sim = new RealBoard(controller('sim'))
    const bench = new MemoryAdapter({ id: 'bench', driver: 'memory', doors: [1, 2] })
    app = await buildServer({ config: config(false), adapters: [real, sim, bench] })
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
  })

  it('refuses the event log and card sync on a real board', async () => {
    const events = await app.inject({ method: 'GET', url: '/v1/controllers/real/events', headers: FULL })
    expect(events.statusCode).toBe(409)
    expect(events.json().error).toBe('door_jobs_off')
    const sync = await app.inject({ method: 'POST', url: '/v1/controllers/real/cards/sync', headers: FULL, payload: SYNC })
    expect(sync.statusCode).toBe(409)
    expect(await real.listCards()).toEqual([])
  })

  it('allows status, open, unlock and lock on a real board', async () => {
    for (const action of ['open', 'unlock', 'lock']) {
      const res = await app.inject({ method: 'POST', url: `/v1/controllers/real/doors/1/${action}`, headers: FULL })
      expect(res.statusCode).toBe(200)
    }
    const status = await app.inject({ method: 'GET', url: '/v1/controllers/real/status', headers: FULL })
    expect(status.statusCode).toBe(200)
  })

  it('refuses every card read and write on a real board', async () => {
    const calls = [
      { method: 'GET', url: '/v1/controllers/real/cards' },
      { method: 'GET', url: '/v1/controllers/real/cards/42' },
      { method: 'PUT', url: '/v1/controllers/real/cards/42', payload: { doors: [1] } },
      { method: 'DELETE', url: '/v1/controllers/real/cards/42' }
    ] as const
    for (const call of calls) {
      const res = await app.inject({ ...call, headers: FULL })
      expect(res.statusCode, `${call.method} ${call.url}`).toBe(409)
      expect(res.json().error).toBe('door_jobs_off')
    }
    expect(await real.listCards()).toEqual([])
  })

  it('allows everything on sandbox controllers', async () => {
    for (const id of ['sim', 'bench']) {
      const events = await app.inject({ method: 'GET', url: `/v1/controllers/${id}/events`, headers: FULL })
      expect(events.statusCode).toBe(200)
      const sync = await app.inject({ method: 'POST', url: `/v1/controllers/${id}/cards/sync`, headers: FULL, payload: SYNC })
      expect(sync.statusCode).toBe(200)
    }
  })

  it('health does not poll a real board', async () => {
    const before = real.statusCalls
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.doorJobs).toBe(false)
    expect(body.controllers.find((c: { id: string }) => c.id === 'real')).toMatchObject({ skipped: 'DOOR_JOBS=off' })
    expect(body.controllers.find((c: { id: string }) => c.id === 'sim')).toMatchObject({ reachable: true })
    expect(real.statusCalls).toBe(before)
  })
})

describe('DOOR_JOBS on (production)', () => {
  it('allows the event log and card sync on a real board, and health polls it', async () => {
    const real = new RealBoard(controller('real'))
    const app = await buildServer({ config: config(true), adapters: [real] })
    await app.ready()
    const events = await app.inject({ method: 'GET', url: '/v1/controllers/real/events', headers: FULL })
    expect(events.statusCode).toBe(200)
    const sync = await app.inject({ method: 'POST', url: '/v1/controllers/real/cards/sync', headers: FULL, payload: SYNC })
    expect(sync.statusCode).toBe(200)
    const health = await app.inject({ method: 'GET', url: '/health' })
    expect(health.json().doorJobs).toBe(true)
    expect(real.statusCalls).toBe(1)
    await app.close()
  })
})
