import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OpenAccessAdapter } from '../src/adapters/openaccess.js'
import { Unreachable } from '../src/errors.js'

// A fake Open Access board: answers the query protocol the way the firmware
// does, and records the queries it received so tests can assert on them.
function fakeBoard(opts: { slow?: boolean } = {}): Server & { queries: string[] } {
  const queries: string[] = []
  const server = createServer((req, res) => {
    const q = (req.url ?? '').split('?')[1] ?? ''
    queries.push(q)
    const cmd = q[0]
    const reply = (text: string) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(text)
    }
    if (opts.slow) {
      setTimeout(() => reply('ok'), 2000)
      return
    }
    if (cmd === '9') return reply('{"door_1_locked":1,"door_2_locked":0}')
    if (cmd === 'a') {
      // dumpUser: slot \t mask \t TAG(hex, uppercase). firmware prints
      // enabled (mask 1), disabled (mask 255 + real tag), empty (tag 0 / FFFFFFFF).
      return reply(
        '<pre>UserNum: Usermask: TagNum:\n' +
          '10\t1\tFF\n' + // enabled, tag 0xff
          '11\t255\tBEEF\n' + // DISABLED but a real tag -> still occupies slot 11
          '12\t255\tFFFFFFFF\n' + // empty/deleted
          '13\t1\t0\n' + // empty
          '</pre>'
      )
    }
    if (cmd === 'm') return reply('<pre>prev:\ncur:\n</pre>')
    if (cmd === 'r') return reply('r\n<pre>prev:\ncur:\n</pre>')
    if (cmd === 'z') return reply('G: 100\r\nD: 101\r\n')
    return reply('ok')
  })
  return Object.assign(server, { queries })
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

describe('OpenAccessAdapter', () => {
  let server: Server & { queries: string[] }
  let adapter: OpenAccessAdapter

  beforeAll(async () => {
    server = fakeBoard()
    const url = await listen(server)
    adapter = new OpenAccessAdapter(
      { id: 'rear', driver: 'openaccess', url, password: '1234', doors: [1, 2] },
      1000
    )
  })
  afterAll(() => {
    server.close()
  })

  it('reads door lock status without authenticating', async () => {
    const status = await adapter.status()
    expect(status.online).toBe(true)
    expect(status.doors).toEqual([
      { door: 1, locked: true },
      { door: 2, locked: false }
    ])
    // ?9 must NOT carry &e= (firmware serves status unauthenticated)
    expect(server.queries).toContain('9')
  })

  it('lists enabled and disabled cards, skips empty slots', async () => {
    const cards = await adapter.listCards()
    expect(cards).toEqual([
      { card: 0xff, doors: [1, 2] }, // enabled
      { card: 0xbeef, doors: [] } // disabled -> present with no access
    ])
  })

  it('sends &e=PW on privileged commands', async () => {
    await adapter.unlock(1)
    expect(server.queries).toContain('u=1&e=1234')
  })

  it('writes a new card to a FREE slot, never over a disabled card', async () => {
    const before = server.queries.length
    await adapter.putCard({ card: 0x2611, doors: [1, 2] })
    const modify = server.queries.slice(before).find((q) => q.startsWith('m'))
    // slots 10 and 11 are occupied (11 is disabled but real), so the next free
    // slot is 12... but 12/13 are empty -> 12. The disabled slot 11 is skipped.
    expect(modify).toMatch(/^m012&p001&t00002611&e=1234/)
  })

  it('updates a disabled card in place (same slot) when re-added', async () => {
    const before = server.queries.length
    await adapter.putCard({ card: 0xbeef, doors: [1, 2] })
    const modify = server.queries.slice(before).find((q) => q.startsWith('m'))
    expect(modify).toMatch(/^m011&p001&t0000beef&e=1234/) // reuses slot 11
  })

  it('deletes a known card and 404s an unknown one', async () => {
    await expect(adapter.deleteCard(0xff)).resolves.toBeUndefined()
    await expect(adapter.deleteCard(0x999999)).rejects.toThrow(/not on this controller/)
  })

  it('parses the event buffer (best-effort, non-incremental)', async () => {
    const page = await adapter.events(0, 10)
    expect(page.events[0]).toMatchObject({ type: 'granted', card: 100, granted: true })
    expect(page.events[1]).toMatchObject({ type: 'denied', card: 101 })
  })

  it('maps an unreachable/slow board to Unreachable', async () => {
    const slow = fakeBoard({ slow: true })
    const url = await listen(slow)
    const slowAdapter = new OpenAccessAdapter(
      { id: 'slow', driver: 'openaccess', url, password: '1234', doors: [1] },
      300
    )
    await expect(slowAdapter.status()).rejects.toBeInstanceOf(Unreachable)
    slow.close()
  })
})
