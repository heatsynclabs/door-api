// Adapter for the legacy Open Access Arduino board (zyphlar/Open_Access_Control_Ethernet).
// It speaks the board's raw HTTP query protocol:
//   ?9                      status (JSON)
//   ?u=<d>&e=PW / ?l=<d>    unlock / lock a door
//   ?o<d>&e=PW              momentary open
//   ?a&e=PW                 list all slots   -> "<slot>\t<mask>\t<tag-hex>" lines
//   ?m<slot>&p<mask>&t<tag>&e=PW   set a slot (reply contains "cur:")
//   ?r<slot>&e=PW           clear a slot
//   ?z&e=PW                 dump the on-board event buffer ("<key>: <value>" lines)
// The board keys cards by EEPROM slot, so this adapter maps card number <-> slot
// itself, which is the slot bookkeeping the members app used to do by hand.
import type { Card, ControllerAdapter, ControllerStatus, DoorEvent, DriverName, EventPage } from '../domain.js'
import type { ControllerConfig } from '../config.js'
import { BadRequest, CapacityFull, NotFound, Unreachable } from '../errors.js'

interface Slot {
  slot: number
  mask: number
  tag: number // card number
}

const ENABLED_MASK = 1
const DISABLED_MASK = 255
// deleteUser writes 0xFF to all 5 bytes, and blank EEPROM reads the same, so an
// empty slot's tag is 0xFFFFFFFF.
const EMPTY_TAG = 0xffffffff

// Event-log key letters the board uses (see the firmware header).
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

export class OpenAccessAdapter implements ControllerAdapter {
  readonly id: string
  readonly driver: DriverName = 'openaccess'
  readonly doors: number[]
  private readonly baseUrl: string
  private readonly password: string
  private readonly slotMin: number
  private readonly slotMax: number
  private readonly timeout: number

  constructor(cfg: ControllerConfig, timeoutMs: number) {
    if (!cfg.url || !cfg.password) throw new Error(`openaccess controller "${cfg.id}" needs url and password`)
    this.id = cfg.id
    this.doors = cfg.doors
    this.baseUrl = cfg.url.replace(/\/$/, '')
    this.password = cfg.password
    this.slotMin = cfg.slotMin ?? 10
    this.slotMax = cfg.slotMax ?? 199
    this.timeout = timeoutMs
  }

  private async get(query: string): Promise<string> {
    const url = `${this.baseUrl}?${query}`
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(this.timeout),
        headers: { 'User-Agent': 'door-api/0.1' }
      })
      return await res.text()
    } catch (err) {
      throw new Unreachable(`open access board did not answer: ${(err as Error).message}`)
    }
  }

  // Privileged commands log in on the same request with &e=PW; the board applies
  // the command and logs itself out.
  private authed(query: string): string {
    return `${query}&e=${this.password}`
  }

  async status(): Promise<ControllerStatus> {
    const body = await this.get('9')
    let raw: Record<string, number>
    try {
      raw = JSON.parse(body)
    } catch {
      throw new Unreachable('open access board returned a non-JSON status')
    }
    const doors = this.doors.map((door) => {
      const locked = raw[`door_${door}_locked`]
      return { door, locked: locked == null ? undefined : locked === 1 }
    })
    return { id: this.id, driver: this.driver, online: true, doors, details: raw }
  }

  async unlock(door: number): Promise<void> {
    this.assertDoor(door)
    await this.get(this.authed(`u=${door}`))
  }

  async lock(door: number): Promise<void> {
    this.assertDoor(door)
    await this.get(this.authed(`l=${door}`))
  }

  async open(door: number): Promise<void> {
    this.assertDoor(door)
    await this.get(this.authed(`o${door}`))
  }

  async listCards(): Promise<Card[]> {
    return (await this.listSlots()).map((s) => this.slotToCard(s))
  }

  async getCard(card: number): Promise<Card | null> {
    const slot = (await this.listSlots()).find((s) => s.tag === card)
    return slot ? this.slotToCard(slot) : null
  }

  async putCard(card: Card): Promise<void> {
    const slots = await this.listSlots()
    const existing = slots.find((s) => s.tag === card.card)
    const slotNumber = existing ? existing.slot : this.nextFreeSlot(slots)
    if (slotNumber == null) throw new CapacityFull()

    const mask = card.doors.length > 0 ? ENABLED_MASK : DISABLED_MASK
    const tag = card.card.toString(16).padStart(8, '0')
    const query = this.authed(
      `m${pad3(slotNumber)}&p${pad3(mask)}&t${tag}`
    )
    const reply = await this.get(query)
    if (!/cur/.test(reply)) throw new Unreachable('open access board did not confirm the card write')
  }

  async deleteCard(card: number): Promise<void> {
    const slot = (await this.listSlots()).find((s) => s.tag === card)
    if (!slot) throw new NotFound(`card ${card} is not on this controller`)
    const reply = await this.get(this.authed(`r${pad3(slot.slot)}`))
    if (!/cur/.test(reply)) throw new Unreachable('open access board did not confirm the card delete')
  }

  // WARNING: the board has NO read cursor. ?z dumps the whole fixed circular
  // buffer every time (and does not clear it), and a card is split across two
  // half-entries (G = number % 32767, g = number / 32767), so these events are
  // neither incremental nor a full card number. `after` is best-effort within a
  // single response only. For the legacy board, prefer draining + clearing (?y)
  // and persisting on the members side; do not resume from an index here.
  async events(after: number, limit: number): Promise<EventPage> {
    const body = await this.get(this.authed('z'))
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

  private assertDoor(door: number): void {
    if (!this.doors.includes(door)) throw new BadRequest(`controller "${this.id}" has no door ${door}`)
  }

  // Occupancy is decided by the TAG, never the mask: a disabled card (mask 255)
  // still has a real tag and still owns its slot, so it must count as occupied or
  // the next write would overwrite it. Only the firmware's empty value
  // (0xFFFFFFFF, written by deleteUser and on blank EEPROM) and 0 are free.
  private async listSlots(): Promise<Slot[]> {
    const body = await this.get(this.authed('a'))
    const slots: Slot[] = []
    for (const line of body.split(/\r?\n/)) {
      const m = line.match(/^(\d+)\t(\d+)\t([0-9a-fA-F]+)/)
      if (!m) continue
      const slot = Number.parseInt(m[1]!, 10)
      const mask = Number.parseInt(m[2]!, 10)
      const tag = Number.parseInt(m[3]!, 16)
      if (tag !== 0 && tag !== EMPTY_TAG) slots.push({ slot, mask, tag })
    }
    return slots
  }

  private nextFreeSlot(used: Slot[]): number | null {
    const taken = new Set(used.map((s) => s.slot))
    for (let n = this.slotMin; n <= this.slotMax; n += 1) {
      if (!taken.has(n)) return n
    }
    return null
  }

  private slotToCard(s: Slot): Card {
    return { card: s.tag, doors: s.mask === DISABLED_MASK ? [] : this.doors }
  }
}

function pad3(n: number): string {
  return n.toString().padStart(3, '0')
}
