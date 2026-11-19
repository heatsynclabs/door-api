// Adapter for the legacy Open Access Arduino board (zyphlar/Open_Access_Control_Ethernet,
// PlatformIO port in heatsynclabs/door-controller-platformio). It speaks the board's
// raw HTTP query protocol, one command per request:
//   ?9                          status (JSON), no password needed
//   ?o<d>                       open door d for DOORDELAY (5 s), then relock
//   ?u=<d> / ?u                 unlock door d / unlock all (unlock all chirps 3x)
//   ?l=<d> / ?l                 lock door d (chirps 3x) / lock all (no chirp)
//   ?2 / ?1                     arm / disarm the alarm (arm blocks ~6 s of chirps)
//   ?a                          list slots 0..199: "<slot>\t<mask>\t<TAG-HEX>"
//   ?m<sss>&p<mmm>&t<tttttttt>  write a slot (reply "prev:" .. "cur:")
//   ?r<sss>                     clear a slot (tag FFFFFFFF, mask 255)
//   ?z / ?y                     print the 40-entry event buffer / clear it
// Privileged commands carry &e=PW: the board logs in, runs the command, and the
// trailing &e= logs it out again, so each request stands alone and no session is
// left open for anyone else on the network.
//
// The firmware compares the password and, after 5 failed logins in 5 minutes,
// refuses every login (any client's) for 5 minutes. So a refused password pauses
// every privileged call to this board (authPauseMs, default 6 minutes): a wrong
// password costs the board one failed login, never five.
import type {
  Card,
  ControllerAdapter,
  ControllerStatus,
  DoorEvent,
  DriverName,
  EventPage,
  SlotChange,
  SlotEntry
} from '../domain.js'
import type { ControllerConfig } from '../config.js'
import { BadReply, BadRequest, BoardAuthFailed, CapacityFull, NotFound, NotSupported, Unreachable } from '../errors.js'

const ENABLED_MASK = 1
const DISABLED_MASK = 255
const SLOTS = 200 // the firmware lists 0..199; slot 200 writes past the end of EEPROM

// Event-log key letters the board uses (see the firmware's log()).
const EVENT_TYPES: Record<string, string> = {
  G: 'granted',
  g: 'granted',
  D: 'denied',
  d: 'denied',
  R: 'read',
  r: 'read',
  L: 'locked',
  U: 'unlocked'
}

export interface OpenAccessOptions {
  timeoutMs: number
  // Listing 200 slots or the log is many small TCP writes on the board.
  slowTimeoutMs?: number
  authPauseMs?: number
  now?: () => number
  // Called when the board accepted a command but its reply lacked the expected
  // confirmation (the deployed firmware may print differently from the repo).
  onWarn?: (message: string, detail: Record<string, unknown>) => void
}

export class OpenAccessAdapter implements ControllerAdapter {
  readonly id: string
  readonly driver: DriverName = 'openaccess'
  readonly doors: number[]
  private readonly baseUrl: string
  private readonly password: string
  private readonly slotMin: number
  private readonly slotMax: number
  private readonly timeout: number
  private readonly slowTimeout: number
  private readonly authPauseMs: number
  private readonly now: () => number
  private readonly onWarn: (message: string, detail: Record<string, unknown>) => void
  private pausedUntil = 0

  constructor(cfg: ControllerConfig, options: OpenAccessOptions | number) {
    const opts: OpenAccessOptions = typeof options === 'number' ? { timeoutMs: options } : options
    if (!cfg.url || !cfg.password) throw new Error(`openaccess controller "${cfg.id}" needs url and password`)
    this.id = cfg.id
    this.doors = cfg.doors
    this.baseUrl = cfg.url.replace(/\/$/, '')
    this.password = cfg.password
    this.slotMin = cfg.slotMin ?? 10
    this.slotMax = cfg.slotMax ?? 199
    this.timeout = opts.timeoutMs
    this.slowTimeout = Math.max(opts.slowTimeoutMs ?? 30_000, opts.timeoutMs)
    this.authPauseMs = opts.authPauseMs ?? 6 * 60_000
    this.now = opts.now ?? Date.now
    this.onWarn = opts.onWarn ?? (() => undefined)
  }

  private async get(query: string, timeoutMs = this.timeout): Promise<string> {
    try {
      const res = await fetch(`${this.baseUrl}/?${query}`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': 'door-api' }
      })
      return await res.text()
    } catch (err) {
      // Never pass the error text on: it could carry the URL, and the URL the password.
      const kind = (err as Error).name === 'TimeoutError' ? 'timed out' : 'did not answer'
      throw new Unreachable(`open access board ${kind}`)
    }
  }

  authPausedUntil(): number | null {
    return this.pausedUntil > this.now() ? this.pausedUntil : null
  }

  // Send a privileged command and check the board accepted the password.
  private async command(query: string, timeoutMs = this.timeout): Promise<string> {
    if (this.authPausedUntil() != null) throw new BoardAuthFailed()
    const reply = await this.get(`${query}&e=${this.password}`, timeoutMs)
    if (/authfail/.test(reply)) {
      this.pausedUntil = this.now() + this.authPauseMs
      throw new BoardAuthFailed()
    }
    if (!/authok/.test(reply)) throw new BadReply('open access board did not confirm the login')
    if (/Not logged in/.test(reply)) throw new BadReply('open access board says not logged in')
    if (/err:/.test(reply)) throw new BadReply('open access board rejected the command')
    return reply
  }

  // Check a command's reply. The command already passed the login check (authok,
  // no err:), so the board ran it. If the reply carries the board's status block,
  // it must show the expected state: a contradiction is an error. If the expected
  // message is simply missing, the command is accepted (the direct path never
  // checked replies at all) and a warning records the reply's shape.
  private confirm(reply: string, what: string, message: RegExp | null, state?: (s: Record<string, number>) => boolean): void {
    if (message && message.test(reply)) return
    const s = statusBlock(reply)
    if (s && state) {
      if (state(s)) return
      throw new BadReply(`open access board status after ${what} does not show it done`)
    }
    this.onWarn('open access board reply had no confirmation; accepted', { controller: this.id, action: what, reply: shape(reply) })
  }

  async status(): Promise<ControllerStatus> {
    const body = await this.get('9')
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    let raw: Record<string, number>
    try {
      raw = JSON.parse(body.slice(start, end + 1))
    } catch {
      throw new BadReply('open access board returned a non-JSON status')
    }
    const doors = this.doors.map((door) => {
      const locked = raw[`door_${door}_locked`]
      return { door, locked: locked == null ? undefined : locked === 1 }
    })
    return { id: this.id, driver: this.driver, online: true, doors, details: raw }
  }

  async unlock(door: number): Promise<void> {
    this.assertDoor(door)
    this.confirm(await this.command(`u=${door}`), `unlock ${door}`, new RegExp(`Unlocked ${door}\\.`), (s) => s[`door_${door}_locked`] === 0)
  }

  // ?l=<d> prints no message, only the status, which must show the door locked.
  async lock(door: number): Promise<void> {
    this.assertDoor(door)
    this.confirm(await this.command(`l=${door}`), `lock ${door}`, null, (s) => s[`door_${door}_locked`] === 1)
  }

  async open(door: number): Promise<void> {
    this.assertDoor(door)
    this.confirm(await this.command(`o${door}`), `open ${door}`, new RegExp(`Opened ${door}\\.`))
  }

  async lockAll(): Promise<void> {
    this.confirm(await this.command('l'), 'lock all', /Locked all\./, (s) => this.doors.every((d) => s[`door_${d}_locked`] === 1))
  }

  async unlockAll(): Promise<void> {
    this.confirm(await this.command('u'), 'unlock all', /Unlocked all\./, (s) => this.doors.every((d) => s[`door_${d}_locked`] === 0))
  }

  async arm(): Promise<void> {
    this.confirm(await this.command('2'), 'arm', null, (s) => s.armed === 1)
  }

  async disarm(): Promise<void> {
    this.confirm(await this.command('1'), 'disarm', null, (s) => s.armed === 0)
  }

  async listSlots(): Promise<{ slots: SlotEntry[]; masked: boolean }> {
    const reply = await this.command('a', this.slowTimeout)
    const slots = parseSlotDump(reply)
    if (slots.length !== SLOTS) throw new BadReply(`open access board listed ${slots.length} slots, expected ${SLOTS}`)
    return { slots, masked: slots.some((s) => s.tag == null && !s.empty) }
  }

  async writeSlot(slot: number, mask: number, tag: string): Promise<SlotChange> {
    this.assertSlot(slot)
    if (!Number.isInteger(mask) || mask < 0 || mask > 255) throw new BadRequest('mask must be 0 to 255')
    const tag8 = normaliseTag(tag)
    const reply = await this.command(`m${pad3(slot)}&p${pad3(mask)}&t${tag8}`)
    const change = parseSlotChange(reply)
    const cur = change.cur
    if (!cur) {
      // "cur:" is there (parseSlotChange checked) but the entry is not in the
      // expected form: the direct path accepts exactly this, so accept and warn.
      this.onWarn('slot write read-back not parsed; accepted on "cur:"', { controller: this.id, slot, reply: shape(reply) })
      return change
    }
    if (cur.slot !== slot || cur.mask !== mask || (cur.tag != null && Number.parseInt(cur.tag, 16) !== Number.parseInt(tag8, 16))) {
      throw new BadReply(`open access board read back something else for slot ${slot}`)
    }
    return change
  }

  async clearSlot(slot: number): Promise<SlotChange> {
    this.assertSlot(slot)
    const reply = await this.command(`r${pad3(slot)}`)
    const change = parseSlotChange(reply)
    if (!change.cur) {
      this.onWarn('slot clear read-back not parsed; accepted on "cur:"', { controller: this.id, slot, reply: shape(reply) })
      return change
    }
    if (change.cur.slot !== slot || !change.cur.empty || change.cur.mask !== DISABLED_MASK) {
      throw new BadReply(`open access board read back slot ${slot} as not empty`)
    }
    return change
  }

  // The raw ?z body from "<pre>" on: byte for byte what the board printed, so the
  // members site parses it exactly as it parses a direct read.
  async readLog(): Promise<string> {
    const reply = await this.command('z', this.slowTimeout)
    const start = reply.indexOf('<pre>')
    if (start >= 0) return reply.slice(start)
    this.onWarn('event log reply had no <pre>; returned after the login line', { controller: this.id, reply: shape(reply) })
    return reply.slice(reply.indexOf('authok') + 'authok'.length).replace(/^\r?\n/, '')
  }

  async clearLog(): Promise<void> {
    this.confirm(await this.command('y'), 'clear log', /(^|\n)y\r?\n/)
  }

  // ---- card-number API (reads the slot table; needs unmasked tags) ----

  async listCards(): Promise<Card[]> {
    return (await this.occupiedSlots()).map((s) => this.slotToCard(s))
  }

  async getCard(card: number): Promise<Card | null> {
    const slot = (await this.occupiedSlots()).find((s) => tagNumber(s) === card)
    return slot ? this.slotToCard(slot) : null
  }

  async putCard(card: Card): Promise<void> {
    const slots = await this.occupiedSlots()
    const existing = slots.find((s) => tagNumber(s) === card.card)
    const slotNumber = existing ? existing.slot : this.nextFreeSlot(slots)
    if (slotNumber == null) throw new CapacityFull()
    const mask = card.doors.length > 0 ? ENABLED_MASK : DISABLED_MASK
    await this.writeSlot(slotNumber, mask, card.card.toString(16))
  }

  async deleteCard(card: number): Promise<void> {
    const matches = (await this.occupiedSlots()).filter((s) => tagNumber(s) === card)
    if (matches.length === 0) throw new NotFound(`card ${card} is not on this controller`)
    for (const s of matches) await this.clearSlot(s.slot)
  }

  // The board has NO read cursor: ?z prints the whole 40-entry buffer every time
  // and does not clear it, and a card is split across two entries (G = number %
  // 32767, g = number / 32767). For the import use readLog/clearLog through the
  // journaled drain (POST .../log/drain), never this.
  async events(after: number, limit: number): Promise<EventPage> {
    const body = await this.readLog()
    const all: DoorEvent[] = []
    let index = 0
    for (const line of body.split(/\r?\n/)) {
      const m = line.match(/^(\w+):\s*(.+)$/)
      if (!m || !m[1]) continue
      const key = m[1]
      const value = Number.parseInt(m[2] ?? '', 10)
      index += 1
      const type = EVENT_TYPES[key] ?? key
      const event: DoorEvent = { index, timestamp: null, type }
      if (type === 'granted' || type === 'denied' || type === 'read') {
        event.card = Number.isNaN(value) ? undefined : value
        event.granted = type === 'granted'
      } else if (!Number.isNaN(value)) {
        event.door = value
      }
      all.push(event)
    }
    const events = all.filter((e) => e.index > after).slice(0, limit)
    return { events, first: all.length ? 1 : 0, last: all.length }
  }

  private async occupiedSlots(): Promise<SlotEntry[]> {
    const { slots, masked } = await this.listSlots()
    if (masked) throw new NotSupported('this board hides card numbers in its slot list (firmware DEBUG below 2); use the slot API')
    return slots.filter((s) => !s.empty)
  }

  private assertDoor(door: number): void {
    if (!this.doors.includes(door)) throw new BadRequest(`controller "${this.id}" has no door ${door}`)
  }

  private assertSlot(slot: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS) throw new BadRequest(`slot must be 0 to ${SLOTS - 1}`)
  }

  private nextFreeSlot(used: SlotEntry[]): number | null {
    const taken = new Set(used.map((s) => s.slot))
    for (let n = this.slotMin; n <= this.slotMax; n += 1) {
      if (!taken.has(n)) return n
    }
    return null
  }

  private slotToCard(s: SlotEntry): Card {
    return { card: tagNumber(s), doors: s.mask === DISABLED_MASK ? [] : this.doors }
  }
}

// The board's status block inside a command reply, if it printed one.
function statusBlock(reply: string): Record<string, number> | null {
  const m = /\{[^{}]*"door_1_locked"[^{}]*\}/.exec(reply)
  if (!m) return null
  try {
    return JSON.parse(m[0]) as Record<string, number>
  } catch {
    return null
  }
}

// A reply's shape for a log line: no card numbers (hex runs become #), short.
function shape(reply: string): string {
  return reply.replace(/[0-9A-Fa-f]{5,}/g, '#').replace(/\r/g, '\\r').replace(/\n/g, '\\n').slice(0, 160)
}

function tagNumber(s: SlotEntry): number {
  return s.tag == null ? Number.NaN : Number.parseInt(s.tag, 16)
}

function pad3(n: number): string {
  return n.toString().padStart(3, '0')
}

// A card number as the board takes it: 8 upper-case hex digits. 0 and FFFFFFFF
// are the firmware's "no card" values, so they cannot be written.
export function normaliseTag(tag: string): string {
  if (!/^[0-9A-Fa-f]{1,8}$/.test(tag)) throw new BadRequest('tag must be 1 to 8 hex digits')
  const tag8 = tag.toUpperCase().padStart(8, '0')
  if (tag8 === '00000000' || tag8 === 'FFFFFFFF') throw new BadRequest('tag 0 and FFFFFFFF mean "no card" on this board')
  return tag8
}

// One dumpUser() entry, as the firmware prints it:
//   print(slot) "\t" print(mask) "\t" then, with DEBUG 2, println(tag, HEX);
//   with a lower DEBUG, println("********") for a used slot and NOTHING (not
//   even a line break) for an empty one.
const ENTRY = /(\d{1,3})\t(\d{1,3})\t(?:(\*{8})\r\n|([0-9A-F]{1,8})\r\n)?/y

function readEntry(text: string, at: number): { entry: SlotEntry; next: number } | null {
  ENTRY.lastIndex = at
  const m = ENTRY.exec(text)
  if (!m) return null
  const slot = Number.parseInt(m[1]!, 10)
  const mask = Number.parseInt(m[2]!, 10)
  let tag: string | null = null
  let empty: boolean
  if (m[4] != null) {
    tag = m[4]
    empty = tag === 'FFFFFFFF' || Number.parseInt(tag, 16) === 0
  } else {
    empty = m[3] == null // masked: "********" for used, nothing for empty
  }
  return { entry: { slot, mask, tag, empty }, next: ENTRY.lastIndex }
}

export function parseSlotDump(body: string): SlotEntry[] {
  const header = body.indexOf('TagNum:\r\n')
  if (header < 0) throw new BadReply('open access board returned no slot list')
  let at = header + 'TagNum:\r\n'.length
  const out: SlotEntry[] = []
  for (;;) {
    const r = readEntry(body, at)
    if (!r) break
    out.push(r.entry)
    at = r.next
  }
  return out
}

// The reply to ?m or ?r: "prev:\r\n" <entry> [ ... ] "cur:\r\n" <entry>.
export function parseSlotChange(body: string): SlotChange {
  const p = body.indexOf('prev:\r\n')
  const c = body.indexOf('cur:\r\n')
  if (p < 0 || c < 0 || c < p) throw new BadReply('open access board did not confirm the slot change')
  const prev = readEntry(body, p + 'prev:\r\n'.length)?.entry ?? null
  const cur = readEntry(body, c + 'cur:\r\n'.length)?.entry ?? null
  return { slot: cur?.slot ?? prev?.slot ?? -1, prev, cur }
}
