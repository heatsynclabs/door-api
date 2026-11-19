// An in-memory controller: no hardware, no network. Used for local development
// without a board and as the fake in route tests. It implements the exact same
// contract as the real adapters.
import type { Card, ControllerAdapter, ControllerStatus, DoorEvent, DriverName, EventPage, SlotChange, SlotEntry } from '../domain.js'
import type { ControllerConfig } from '../config.js'
import { BadRequest, NotFound } from '../errors.js'

export class MemoryAdapter implements ControllerAdapter {
  readonly id: string
  readonly driver: DriverName = 'memory'
  readonly doors: number[]
  private readonly cards = new Map<number, Card>()
  private readonly locked = new Map<number, boolean>()
  private readonly log: DoorEvent[] = []
  private readonly slots = new Map<number, { mask: number; tag: string }>()
  private boardLog: string[] = []
  armed = false

  constructor(cfg: ControllerConfig) {
    this.id = cfg.id
    this.doors = cfg.doors
    for (const d of this.doors) this.locked.set(d, true)
  }

  async status(): Promise<ControllerStatus> {
    return {
      id: this.id,
      driver: this.driver,
      online: true,
      doors: this.doors.map((door) => ({ door, locked: this.locked.get(door) }))
    }
  }

  async unlock(door: number): Promise<void> {
    this.assertDoor(door)
    this.locked.set(door, false)
    this.boardLog.push(`U: ${door}`)
    this.record('unlocked', { door })
  }

  async lock(door: number): Promise<void> {
    this.assertDoor(door)
    this.locked.set(door, true)
    this.boardLog.push(`L: ${door}`)
    this.record('locked', { door })
  }

  async open(door: number): Promise<void> {
    this.assertDoor(door)
    this.record('opened', { door })
  }

  async listCards(): Promise<Card[]> {
    return [...this.cards.values()].map((c) => ({ ...c }))
  }

  async getCard(card: number): Promise<Card | null> {
    const found = this.cards.get(card)
    return found ? { ...found } : null
  }

  async putCard(card: Card): Promise<void> {
    for (const d of card.doors) this.assertDoor(d)
    this.cards.set(card.card, { ...card })
  }

  async deleteCard(card: number): Promise<void> {
    if (!this.cards.delete(card)) throw new NotFound(`card ${card} is not on this controller`)
  }

  async events(after: number, limit: number): Promise<EventPage> {
    const events = this.log.filter((e) => e.index > after).slice(0, limit)
    return { events, first: this.log.length ? 1 : 0, last: this.log.length }
  }

  async lockAll(): Promise<void> {
    for (const d of this.doors) await this.lock(d)
  }

  async unlockAll(): Promise<void> {
    for (const d of this.doors) await this.unlock(d)
  }

  async arm(): Promise<void> {
    this.armed = true
  }

  async disarm(): Promise<void> {
    this.armed = false
  }

  private entry(slot: number): SlotEntry {
    const s = this.slots.get(slot)
    return s ? { slot, mask: s.mask, tag: s.tag, empty: false } : { slot, mask: 255, tag: 'FFFFFFFF', empty: true }
  }

  async listSlots(): Promise<{ slots: SlotEntry[]; masked: boolean }> {
    return { slots: Array.from({ length: 200 }, (_, i) => this.entry(i)), masked: false }
  }

  async writeSlot(slot: number, mask: number, tag: string): Promise<SlotChange> {
    const prev = this.entry(slot)
    this.slots.set(slot, { mask, tag: tag.toUpperCase().replace(/^0+(?=.)/, '') })
    this.boardLog.push(`a: ${slot}`)
    return { slot, prev, cur: this.entry(slot) }
  }

  async clearSlot(slot: number): Promise<SlotChange> {
    const prev = this.entry(slot)
    this.slots.delete(slot)
    this.boardLog.push(`d: ${slot}`)
    return { slot, prev, cur: this.entry(slot) }
  }

  // Shaped like the Open Access board's ?z reply: 40 "<key>: <data>" lines.
  async readLog(): Promise<string> {
    const lines = Array.from({ length: 40 }, (_, i) => this.boardLog[i] ?? '\u0000: 0')
    return `<pre>\r\n${lines.join('\r\n')}\r\n</pre>\r\n`
  }

  async clearLog(): Promise<void> {
    this.boardLog = []
  }

  private record(type: string, extra: Partial<DoorEvent>): void {
    this.log.push({ index: this.log.length + 1, timestamp: new Date().toISOString(), type, ...extra })
  }

  private assertDoor(door: number): void {
    if (!this.doors.includes(door)) throw new BadRequest(`controller "${this.id}" has no door ${door}`)
  }
}
