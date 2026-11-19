import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OpenAccessAdapter, normaliseTag, parseSlotChange, parseSlotDump } from '../src/adapters/openaccess.js'
import { BadReply, BadRequest, BoardAuthFailed, NotSupported, Unreachable } from '../src/errors.js'

// The firmware's exact reply bytes (src/main.cpp in door-controller-platformio):
// printStatus(), dumpUser(), printLog(), and the PROGMEM messages, which are
// printed without a line break.
const status = (s: { armed?: number; d1?: number; d2?: number } = {}) =>
  `{\r\n"armed":${s.armed ?? 0},"activated":0\r\n,"alarm_3":0\r\n,"alarm_2":0\r\n,"door_1_locked":${s.d1 ?? 1}\r\n,"door_2_locked":${s.d2 ?? 1}\r\n}\r\n`

function dump(slot: number, mask: number, tag: number, debug: number): string {
  const head = `${slot}\t${mask}\t`
  if (debug === 2) return `${head}${tag.toString(16).toUpperCase()}\r\n`
  return tag === 0xffffffff ? head : `${head}********\r\n`
}

// A fake board answering the query protocol the way the firmware does, with an
// EEPROM-like slot table, and recording every query it received.
function fakeBoard(opts: { debug?: number; slow?: boolean; password?: string } = {}) {
  const debug = opts.debug ?? 2
  const password = opts.password ?? '1234'
  const queries: string[] = []
  const slots = new Map<number, { mask: number; tag: number }>()
  const slot = (n: number) => slots.get(n) ?? { mask: 255, tag: 0xffffffff }
  let log: string[] = []
  const server = createServer((req, res) => {
    const q = (req.url ?? '').split('?')[1] ?? ''
    queries.push(q)
    const send = (text: string) => {
      res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'text/html' })
      res.end(text)
    }
    if (opts.slow) return void setTimeout(() => send('late'), 2000)
    if (q === '9') return send(status())
    const pw = /&e=([0-9A-Fa-f]{4})/.exec(q)?.[1]
    if (!pw) return send("<a href='/'>Not logged in.</a>")
    if (pw !== password) return send('authfail\r\n')
    let out = 'authok\r\n'
    const cmd = q.split('&')[0]!
    if (cmd === 'u=1') out += 'Unlocked 1.' + status({ d1: 0 })
    else if (cmd === 'l=1') out += status({ d1: 1 })
    else if (cmd === 'o1') out += 'Opened 1.'
    else if (cmd === 'l') out += 'Locked all.' + status()
    else if (cmd === 'u') out += 'Unlocked all.' + status({ d1: 0, d2: 0 })
    else if (cmd === '2') out += status({ armed: 1 })
    else if (cmd === '1') out += status({ armed: 0 })
    else if (cmd === 'a') {
      out += '<pre>\r\nUserNum: Usermask: TagNum:\r\n'
      for (let i = 0; i < 200; i += 1) out += dump(i, slot(i).mask, slot(i).tag, debug)
      out += '</pre>\r\n'
    } else if (/^m\d{3}$/.test(cmd)) {
      const n = Number(cmd.slice(1))
      const m = /&p(\d{3})&t([0-9A-Fa-f]{8})/.exec(q)
      if (!m) out += 'err:query\r\n'
      else {
        out += '<pre>\r\nprev:\r\n' + dump(n, slot(n).mask, slot(n).tag, debug)
        slots.set(n, { mask: Number(m[1]), tag: Number.parseInt(m[2]!, 16) })
        out += 'cur:\r\n' + dump(n, slot(n).mask, slot(n).tag, debug) + '</pre>\r\n'
      }
    } else if (/^r\d{3}$/.test(cmd)) {
      const n = Number(cmd.slice(1))
      out += 'r\r\n<pre>\r\nprev:\r\n' + dump(n, slot(n).mask, slot(n).tag, debug)
      slots.delete(n)
      out += 'cur:\r\n' + dump(n, slot(n).mask, slot(n).tag, debug)
    } else if (cmd === 'z') {
      out += '<pre>\r\n'
      for (let i = 0; i < 40; i += 1) out += log[i] ?? '\u0000: 0\r\n'
      out += '</pre>\r\n'
    } else if (cmd === 'y') {
      log = []
      out += 'y\r\n'
    }
    send(out)
  })
  return Object.assign(server, { queries, slots, setLog: (l: string[]) => (log = l) })
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

const cfg = (url: string, password = '1234') => ({ id: 'front', driver: 'openaccess' as const, url, password, doors: [1, 2] })

describe('OpenAccessAdapter (firmware replies)', () => {
  let board: ReturnType<typeof fakeBoard>
  let adapter: OpenAccessAdapter

  beforeAll(async () => {
    board = fakeBoard()
    adapter = new OpenAccessAdapter(cfg(await listen(board)), 1000)
  })
  afterAll(() => board.close())
  beforeEach(() => {
    board.queries.length = 0
  })

  it('reads status without a password', async () => {
    const s = await adapter.status()
    expect(s.doors).toEqual([
      { door: 1, locked: true },
      { door: 2, locked: true }
    ])
    expect(s.details).toEqual({ armed: 0, activated: 0, alarm_3: 0, alarm_2: 0, door_1_locked: 1, door_2_locked: 1 })
    expect(Object.keys(s.details!)).toEqual(['armed', 'activated', 'alarm_3', 'alarm_2', 'door_1_locked', 'door_2_locked'])
    expect(board.queries).toEqual(['9'])
  })

  it('sends each door command as one request with &e=, the way members did', async () => {
    await adapter.open(1)
    await adapter.unlock(1)
    await adapter.lock(1)
    await adapter.lockAll()
    await adapter.unlockAll()
    await adapter.arm()
    await adapter.disarm()
    expect(board.queries).toEqual(['o1&e=1234', 'u=1&e=1234', 'l=1&e=1234', 'l&e=1234', 'u&e=1234', '2&e=1234', '1&e=1234'])
  })

  it('writes a slot exactly as members upload_query does, and checks the board read it back', async () => {
    const change = await adapter.writeSlot(10, 1, '12abcd')
    expect(board.queries).toEqual(['m010&p001&t0012ABCD&e=1234'])
    expect(change.prev).toEqual({ slot: 10, mask: 255, tag: 'FFFFFFFF', empty: true })
    expect(change.cur).toEqual({ slot: 10, mask: 1, tag: '12ABCD', empty: false })
    await adapter.writeSlot(10, 255, '12ABCD')
    expect(board.queries[1]).toBe('m010&p255&t0012ABCD&e=1234')
  })

  it('clears a slot and checks it is empty', async () => {
    await adapter.writeSlot(11, 1, 'BEEF')
    const change = await adapter.clearSlot(11)
    expect(board.queries.at(-1)).toBe('r011&e=1234')
    expect(change.cur).toEqual({ slot: 11, mask: 255, tag: 'FFFFFFFF', empty: true })
  })

  it('lists all 200 slots', async () => {
    await adapter.writeSlot(12, 1, 'ABC')
    const { slots, masked } = await adapter.listSlots()
    expect(masked).toBe(false)
    expect(slots).toHaveLength(200)
    expect(slots[12]).toEqual({ slot: 12, mask: 1, tag: 'ABC', empty: false })
    expect(slots[13]).toEqual({ slot: 13, mask: 255, tag: 'FFFFFFFF', empty: true })
  })

  it('refuses slot 200 and above, and the "no card" tags', async () => {
    await expect(adapter.writeSlot(200, 1, 'AB')).rejects.toBeInstanceOf(BadRequest)
    await expect(adapter.writeSlot(10, 1, 'FFFFFFFF')).rejects.toBeInstanceOf(BadRequest)
    await expect(adapter.writeSlot(10, 1, '0')).rejects.toBeInstanceOf(BadRequest)
    await expect(adapter.writeSlot(10, 1, '12&e=0')).rejects.toBeInstanceOf(BadRequest)
    expect(board.queries).toEqual([])
  })

  it('returns the event log from <pre> on, byte for byte, and clears it', async () => {
    board.setLog(['U: 1\r\n', 'L: 1\r\n', 'G: 1234\r\n', 'g: 5\r\n'])
    const raw = await adapter.readLog()
    expect(raw.startsWith('<pre>\r\nU: 1\r\nL: 1\r\nG: 1234\r\ng: 5\r\n\u0000: 0\r\n')).toBe(true)
    expect(raw.endsWith('</pre>\r\n')).toBe(true)
    expect(raw).not.toContain('authok')
    await adapter.clearLog()
    expect(board.queries).toEqual(['z&e=1234', 'y&e=1234'])
  })

  it('works with the card-number API when tags are visible', async () => {
    await adapter.putCard({ card: 0xabcd, doors: [1, 2] })
    expect(await adapter.getCard(0xabcd)).toEqual({ card: 0xabcd, doors: [1, 2] })
    await adapter.deleteCard(0xabcd)
    expect(await adapter.getCard(0xabcd)).toBeNull()
  })
})

describe('OpenAccessAdapter safety', () => {
  it('pauses every privileged call after one refused password, and keeps status working', async () => {
    const board = fakeBoard({ password: '9999' })
    let now = 1_000_000
    const adapter = new OpenAccessAdapter(cfg(await listen(board)), { timeoutMs: 1000, authPauseMs: 360_000, now: () => now })
    await expect(adapter.unlock(1)).rejects.toBeInstanceOf(BoardAuthFailed)
    await expect(adapter.open(1)).rejects.toBeInstanceOf(BoardAuthFailed)
    await expect(adapter.readLog()).rejects.toBeInstanceOf(BoardAuthFailed)
    expect(board.queries).toEqual(['u=1&e=1234']) // one failed login, not five
    expect(adapter.authPausedUntil()).toBe(1_360_000)
    await adapter.status()
    now += 360_001
    expect(adapter.authPausedUntil()).toBeNull()
    await expect(adapter.unlock(1)).rejects.toBeInstanceOf(BoardAuthFailed)
    expect(board.queries).toEqual(['u=1&e=1234', '9', 'u=1&e=1234'])
    board.close()
  })

  it('treats replies without authok, or with err:, as bad replies', async () => {
    const server = createServer((req, res) => {
      const q = (req.url ?? '').split('?')[1] ?? ''
      res.end(q.startsWith('m') ? 'authok\r\nerr:query\r\n' : "<a href='/'>Not logged in.</a>")
    })
    const adapter = new OpenAccessAdapter(cfg(await listen(server)), 1000)
    await expect(adapter.unlock(1)).rejects.toBeInstanceOf(BadReply)
    await expect(adapter.writeSlot(10, 1, 'AB')).rejects.toBeInstanceOf(BadReply)
    server.close()
  })

  it('accepts a command whose reply lacks the confirmation (with a warning), but not one whose status contradicts it', async () => {
    const replies: Record<string, string> = {
      'o1': 'authok\r\n', // no "Opened 1."
      'u=1': 'authok\r\n' + status({ d1: 1 }), // status says still locked
      'l=2': 'authok\r\n' + status({ d2: 1 }),
      'm010': 'authok\r\n<pre>\r\nprev:\r\nweird\r\ncur:\r\nweird\r\n</pre>\r\n' // read-back not parseable
    }
    const server = createServer((req, res) => {
      const cmd = ((req.url ?? '').split('?')[1] ?? '').split('&')[0]!
      res.end(replies[cmd] ?? 'authok\r\n')
    })
    const warnings: string[] = []
    const adapter = new OpenAccessAdapter(cfg(await listen(server)), { timeoutMs: 1000, onWarn: (m) => warnings.push(m) })
    await adapter.open(1)
    expect(warnings).toHaveLength(1)
    await expect(adapter.unlock(1)).rejects.toBeInstanceOf(BadReply)
    await adapter.lock(2)
    await adapter.writeSlot(10, 1, 'AB')
    expect(warnings).toHaveLength(2)
    server.close()
  })

  it('refuses card-number reads when the firmware masks tags, but slot writes still work', async () => {
    const board = fakeBoard({ debug: 1 })
    const adapter = new OpenAccessAdapter(cfg(await listen(board)), 1000)
    const change = await adapter.writeSlot(10, 1, 'ABCD')
    expect(change.cur).toEqual({ slot: 10, mask: 1, tag: null, empty: false })
    const { slots, masked } = await adapter.listSlots()
    expect(masked).toBe(true)
    expect(slots).toHaveLength(200)
    expect(slots[10]).toEqual({ slot: 10, mask: 1, tag: null, empty: false })
    expect(slots[11]).toEqual({ slot: 11, mask: 255, tag: null, empty: true })
    await expect(adapter.listCards()).rejects.toBeInstanceOf(NotSupported)
    const cleared = await adapter.clearSlot(10)
    expect(cleared.cur).toEqual({ slot: 10, mask: 255, tag: null, empty: true })
    board.close()
  })

  it('maps a slow board to Unreachable, with no URL or password in the message', async () => {
    const board = fakeBoard({ slow: true })
    const adapter = new OpenAccessAdapter(cfg(await listen(board), 'abcd'), 300)
    const err = await adapter.unlock(1).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Unreachable)
    expect((err as Error).message).not.toMatch(/abcd|127\.0\.0\.1|http/)
    board.close()
  })
})

describe('reply parsers', () => {
  it('reads glued masked entries (an empty slot prints no line break)', () => {
    const body = 'authok\r\n<pre>\r\nUserNum: Usermask: TagNum:\r\n0\t255\t1\t1\t********\r\n2\t255\t</pre>\r\n'
    expect(parseSlotDump(body)).toEqual([
      { slot: 0, mask: 255, tag: null, empty: true },
      { slot: 1, mask: 1, tag: null, empty: false },
      { slot: 2, mask: 255, tag: null, empty: true }
    ])
  })

  it('reads a ?r reply, which has no closing </pre>', () => {
    const c = parseSlotChange('authok\r\nr\r\n<pre>\r\nprev:\r\n10\t1\t12ABCD\r\ncur:\r\n10\t255\tFFFFFFFF\r\n')
    expect(c).toEqual({
      slot: 10,
      prev: { slot: 10, mask: 1, tag: '12ABCD', empty: false },
      cur: { slot: 10, mask: 255, tag: 'FFFFFFFF', empty: true }
    })
  })

  it('normalises tags the way upload_query pads them', () => {
    expect(normaliseTag('12abcd')).toBe('0012ABCD')
    expect(() => normaliseTag('')).toThrow()
    expect(() => normaliseTag('ffffffff')).toThrow()
  })
})
