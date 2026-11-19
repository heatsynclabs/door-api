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
    doorJobs: true,
    apiKeys: new Map([
      ['ro', { name: 'ro', scope: 'readonly' as const }],
      ['door', { name: 'door', scope: 'door' as const }],
      ['full', { name: 'full', scope: 'full' as const }]
    ]),
    controllers: [{ id: 'front', driver: 'memory', doors: [1, 2] }],
    timeouts: { hardware: 1000, server: 5000, doorActionDeadline: 3000 },
    authPauseMs: 360000,
    journalDir: null,
    auditFile: null,
    circuit: { enabled: false, errorThresholdPercentage: 50, resetTimeout: 1000, volumeThreshold: 5 },
    uhppote: { bind: '0.0.0.0', broadcast: '255.255.255.255:60000', listen: '0.0.0.0:60001' }
  }
}

const RO = { authorization: 'Bearer ro' }
const FULL = { authorization: 'Bearer full' }
const DOOR = { authorization: 'Bearer door' }

describe('door-api routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildServer({ config: testConfig() })
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
  })

  it('health is liveness only and needs no key', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok', doorJobs: true })
    expect(res.json().controllers).toBeUndefined()
  })

  it('reports controller reachability behind a key', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/health/controllers' })).statusCode).toBe(401)
    const res = await app.inject({ method: 'GET', url: '/v1/health/controllers', headers: RO })
    expect(res.statusCode).toBe(200)
    expect(res.json().controllers[0]).toMatchObject({ id: 'front', driver: 'memory', reachable: true })
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

  it('lets a door key move doors and arm the alarm, but not write cards or drain the log', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/controllers/front/doors/1/open', headers: DOOR })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/v1/controllers/front/doors/lock', headers: DOOR })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/v1/controllers/front/alarm/arm', headers: DOOR })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/v1/controllers/front/alarm/disarm', headers: DOOR })).statusCode).toBe(200)
    const put = await app.inject({ method: 'PUT', url: '/v1/controllers/front/slots/10', headers: DOOR, payload: { tag: 'ABCD', mask: 1 } })
    expect(put.statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/v1/controllers/front/log/drain', headers: DOOR })).statusCode).toBe(403)
  })

  it('locks and unlocks every door at once', async () => {
    const unlock = await app.inject({ method: 'POST', url: '/v1/controllers/front/doors/unlock', headers: DOOR })
    expect(unlock.json()).toEqual({ ok: true, message: 'all doors unlock' })
    let doors = (await app.inject({ method: 'GET', url: '/v1/controllers/front/status', headers: RO })).json().doors
    expect(doors.map((d: { locked: boolean }) => d.locked)).toEqual([false, false])
    await app.inject({ method: 'POST', url: '/v1/controllers/front/doors/lock', headers: DOOR })
    doors = (await app.inject({ method: 'GET', url: '/v1/controllers/front/status', headers: RO })).json().doors
    expect(doors.map((d: { locked: boolean }) => d.locked)).toEqual([true, true])
  })

  it('writes and clears a slot, and validates tag, mask and slot', async () => {
    const put = await app.inject({ method: 'PUT', url: '/v1/controllers/front/slots/12', headers: FULL, payload: { tag: '00abCD', mask: 1 } })
    expect(put.statusCode).toBe(200)
    expect(put.json()).toMatchObject({ ok: true, slot: 12, prev: { empty: true }, cur: { slot: 12, mask: 1, tag: 'ABCD', empty: false } })
    const bad = [
      { url: '/v1/controllers/front/slots/200', payload: { tag: 'AB', mask: 1 } },
      { url: '/v1/controllers/front/slots/12', payload: { tag: 'XYZ', mask: 1 } },
      { url: '/v1/controllers/front/slots/12', payload: { tag: '123456789', mask: 1 } },
      { url: '/v1/controllers/front/slots/12', payload: { tag: 'AB', mask: 256 } }
    ]
    for (const b of bad) {
      const res = await app.inject({ method: 'PUT', headers: FULL, ...b })
      expect(res.statusCode, JSON.stringify(b)).toBe(400)
    }
    const del = await app.inject({ method: 'DELETE', url: '/v1/controllers/front/slots/12', headers: FULL })
    expect(del.json()).toMatchObject({ ok: true, cur: { slot: 12, empty: true } })
  })

  it('drains the board log once, keeps it until acknowledged, then forgets it', async () => {
    await app.inject({ method: 'POST', url: '/v1/controllers/front/doors/1/unlock', headers: FULL })
    const first = await app.inject({ method: 'POST', url: '/v1/controllers/front/log/drain', headers: FULL })
    expect(first.statusCode).toBe(200)
    const drains = first.json().drains
    expect(drains).toHaveLength(1)
    expect(drains[0].raw).toMatch(/^<pre>\r\n/)
    expect(drains[0].raw).toContain('U: 1\r\n')
    expect(drains[0].cleared).toBe(true)
    // not acknowledged yet: the next drain returns it again, plus a new (empty) one
    const second = (await app.inject({ method: 'POST', url: '/v1/controllers/front/log/drain', headers: FULL })).json().drains
    expect(second.map((d: { drain_id: string }) => d.drain_id)[0]).toBe(drains[0].drain_id)
    expect(second[1].raw).not.toContain('U: 1')
    for (const d of second) {
      const ack = await app.inject({ method: 'POST', url: '/v1/controllers/front/log/ack', headers: FULL, payload: { drain_id: d.drain_id } })
      expect(ack.statusCode).toBe(200)
    }
    const again = await app.inject({ method: 'POST', url: '/v1/controllers/front/log/ack', headers: FULL, payload: { drain_id: drains[0].drain_id } })
    expect(again.statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/v1/controllers/front/log/pending', headers: RO })).json()).toEqual({ pending: [] })
  })
})
