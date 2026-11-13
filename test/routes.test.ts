import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import type { Config } from '../src/config.js'

function testConfig(): Config {
  return {
    host: '127.0.0.1',
    port: 0,
    env: 'test',
    logLevel: 'silent',
    apiKeys: new Map([
      ['ro', 'readonly'],
      ['full', 'full']
    ]),
    controllers: [{ id: 'front', driver: 'memory', doors: [1, 2] }],
    timeouts: { hardware: 1000, server: 5000 },
    circuit: { enabled: false, errorThresholdPercentage: 50, resetTimeout: 1000, volumeThreshold: 5 },
    uhppote: { bind: '0.0.0.0', broadcast: '255.255.255.255:60000', listen: '0.0.0.0:60001' }
  }
}

const RO = { authorization: 'Bearer ro' }
const FULL = { authorization: 'Bearer full' }

describe('door-api routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildServer({ config: testConfig() })
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
  })

  it('health reports the controller reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('healthy')
    expect(body.controllers[0]).toMatchObject({ id: 'front', driver: 'memory', reachable: true })
  })

  it('rejects a missing API key with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/controllers' })
    expect(res.statusCode).toBe(401)
  })

  it('lists controllers with a readonly key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/controllers', headers: RO })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([{ id: 'front', driver: 'memory', doors: [1, 2] }])
  })

  it('forbids door control with a readonly key (403)', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/controllers/front/doors/1/unlock', headers: RO })
    expect(res.statusCode).toBe(403)
  })

  it('unlocks a door with a full key and reflects it in status', async () => {
    const unlock = await app.inject({ method: 'POST', url: '/v1/controllers/front/doors/1/unlock', headers: FULL })
    expect(unlock.statusCode).toBe(200)
    expect(unlock.json()).toEqual({ ok: true, message: 'door 1 unlock' })

    const status = await app.inject({ method: 'GET', url: '/v1/controllers/front/status', headers: RO })
    const door1 = status.json().doors.find((d: { door: number }) => d.door === 1)
    expect(door1.locked).toBe(false)
  })

  it('404s an unknown controller', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/controllers/nope/status', headers: RO })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('not_found')
  })

  it('rejects a door number outside 1..4 with 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/controllers/front/doors/9/unlock', headers: FULL })
    expect(res.statusCode).toBe(400)
  })

  it('creates, reads, lists and deletes a card', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/controllers/front/cards/12345',
      headers: FULL,
      payload: { doors: [1, 2] }
    })
    expect(put.statusCode).toBe(200)

    const get = await app.inject({ method: 'GET', url: '/v1/controllers/front/cards/12345', headers: RO })
    expect(get.statusCode).toBe(200)
    expect(get.json()).toEqual({ card: 12345, doors: [1, 2] })

    const list = await app.inject({ method: 'GET', url: '/v1/controllers/front/cards', headers: RO })
    expect(list.json()).toContainEqual({ card: 12345, doors: [1, 2] })

    const del = await app.inject({ method: 'DELETE', url: '/v1/controllers/front/cards/12345', headers: FULL })
    expect(del.statusCode).toBe(200)

    const gone = await app.inject({ method: 'GET', url: '/v1/controllers/front/cards/12345', headers: RO })
    expect(gone.statusCode).toBe(404)
  })

  it('rejects a card for a door the controller does not have', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/controllers/front/cards/999',
      headers: FULL,
      payload: { doors: [3] }
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns events after an index', async () => {
    await app.inject({ method: 'POST', url: '/v1/controllers/front/doors/2/open', headers: FULL })
    const res = await app.inject({ method: 'GET', url: '/v1/controllers/front/events?after=0&limit=10', headers: RO })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.events)).toBe(true)
    expect(body.last).toBeGreaterThan(0)
  })

  it('syncs a desired card set (full key)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/controllers/front/cards/sync',
      headers: FULL,
      payload: { cards: [{ card: 555, doors: [1] }, { card: 556, doors: [1, 2] }], prune: true }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ added: 2, failed: [] })
  })

  it('forbids sync with a readonly key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/controllers/front/cards/sync',
      headers: RO,
      payload: { cards: [] }
    })
    expect(res.statusCode).toBe(403)
  })
})
