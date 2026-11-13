// Adapter for UHPPOTE / UT0311-L0x TCP-IP Wiegand controllers (the MENGQI board
// and its many rebrands). It wraps the official `uhppoted` npm library, which
// speaks the controllers' UDP protocol. Unlike the Arduino, these boards key
// cards by card NUMBER and carry per-door rights plus a validity window, so the
// mapping here is close to one-to-one.
//
// The library ships no TypeScript types and its response field names are only
// fully pinned down against real hardware or the project's simulator, so this
// adapter reads responses defensively and keeps the raw payload in `details`.
import uhppoted, { type Ctx, type ControllerRef } from 'uhppoted'
import type { Card, ControllerAdapter, ControllerStatus, DoorEvent, DriverName, EventPage } from '../domain.js'
import type { ControllerConfig } from '../config.js'
import { BadRequest, Unreachable } from '../errors.js'

// Door control modes in the UHPPOTE protocol.
const MODE_NORMALLY_OPEN = 1 // held unlocked
const MODE_NORMALLY_CLOSED = 2 // locked
// (3 = controlled: momentary unlock on a granted swipe)

const DEFAULT_FROM = '2024-01-01'
const DEFAULT_TO = '2099-12-31'

/* eslint-disable @typescript-eslint/no-explicit-any */
export class UhppoteAdapter implements ControllerAdapter {
  readonly id: string
  readonly driver: DriverName = 'uhppote'
  readonly doors: number[]
  private readonly serial: number
  private readonly ref: ControllerRef
  private readonly ctx: Ctx

  constructor(cfg: ControllerConfig, net: { bind: string; broadcast: string; listen: string }, timeoutMs: number) {
    if (cfg.serial == null) throw new Error(`uhppote controller "${cfg.id}" needs a serial`)
    this.id = cfg.id
    this.doors = cfg.doors
    this.serial = cfg.serial
    this.ref = cfg.address ? { controller: cfg.serial, address: cfg.address } : cfg.serial
    this.ctx = {
      config: new uhppoted.Config('door-api', net.bind, net.broadcast, net.listen, timeoutMs, [], false)
    }
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      throw new Unreachable(`uhppote controller ${this.serial} did not answer: ${(err as Error).message}`)
    }
  }

  async status(): Promise<ControllerStatus> {
    const resp: any = await this.call(() => uhppoted.getStatus(this.ctx, this.ref))
    const s = resp?.status ?? resp ?? {}
    const doorStates: any = s.doors ?? s.door ?? {}
    const doors = this.doors.map((door) => {
      const open = doorStates?.[door]
      return { door, open: typeof open === 'boolean' ? open : undefined }
    })
    return { id: this.id, driver: this.driver, online: true, doors, details: s }
  }

  async unlock(door: number): Promise<void> {
    this.assertDoor(door)
    await this.setMode(door, MODE_NORMALLY_OPEN)
  }

  async lock(door: number): Promise<void> {
    this.assertDoor(door)
    await this.setMode(door, MODE_NORMALLY_CLOSED)
  }

  async open(door: number): Promise<void> {
    this.assertDoor(door)
    await this.call(() => uhppoted.openDoor(this.ctx, this.ref, door))
  }

  private async setMode(door: number, mode: number): Promise<void> {
    // Preserve the configured auto-close delay; only change the control mode.
    const current: any = await this.call(() => uhppoted.getDoorControl(this.ctx, this.ref, door))
    const delay = Number(current?.delay ?? current?.doorControl?.delay ?? 5)
    await this.call(() => uhppoted.setDoorControl(this.ctx, this.ref, door, delay, mode))
  }

  async listCards(): Promise<Card[]> {
    const countResp: any = await this.call(() => uhppoted.getCards(this.ctx, this.ref))
    const count = Number(countResp?.cards ?? countResp?.records ?? countResp ?? 0)
    const cards: Card[] = []
    for (let index = 1; index <= count; index += 1) {
      const resp: any = await this.call(() => uhppoted.getCardByIndex(this.ctx, this.ref, index))
      const card = this.mapCard(resp)
      if (card) cards.push(card)
    }
    return cards
  }

  async getCard(card: number): Promise<Card | null> {
    const resp: any = await this.call(() => uhppoted.getCard(this.ctx, this.ref, card))
    return this.mapCard(resp)
  }

  async putCard(card: Card): Promise<void> {
    const doorMap: Record<number, boolean> = { 1: false, 2: false, 3: false, 4: false }
    for (const d of card.doors) doorMap[d] = true
    await this.call(() =>
      uhppoted.putCard(this.ctx, this.ref, card.card, card.from ?? DEFAULT_FROM, card.to ?? DEFAULT_TO, doorMap)
    )
  }

  async deleteCard(card: number): Promise<void> {
    await this.call(() => uhppoted.deleteCard(this.ctx, this.ref, card))
  }

  async events(after: number, limit: number): Promise<EventPage> {
    const resp: any = await this.call(() => uhppoted.getEvents(this.ctx, this.ref))
    const first = Number(resp?.events?.first ?? resp?.first ?? 0)
    const last = Number(resp?.events?.last ?? resp?.last ?? 0)
    const start = Math.max(after + 1, first)
    const events: DoorEvent[] = []
    for (let index = start; index <= last && events.length < limit; index += 1) {
      const evResp: any = await this.call(() => uhppoted.getEvent(this.ctx, this.ref, index))
      const ev = evResp?.event ?? evResp
      if (!ev) continue
      events.push({
        index: Number(ev.index ?? index),
        timestamp: ev.timestamp ? String(ev.timestamp) : null,
        type: String(ev.eventType?.label ?? ev.type ?? ev.reason ?? 'event'),
        door: ev.door != null ? Number(ev.door) : undefined,
        card: ev.card != null ? Number(ev.card) : undefined,
        granted: typeof ev.granted === 'boolean' ? ev.granted : undefined,
        reason: ev.reason != null ? String(ev.reason) : undefined
      })
    }
    return { events, first, last }
  }

  private mapCard(resp: any): Card | null {
    const c = resp?.card ?? resp
    const number = Number(c?.card ?? c?.cardNumber ?? 0)
    if (!number) return null
    const doorMap: any = c?.doors ?? {}
    const doors = this.doors.filter((d) => doorMap[d] === true || Number(doorMap[d]) > 0)
    const card: Card = { card: number, doors }
    if (c?.from ?? c?.validFrom) card.from = String(c.from ?? c.validFrom)
    if (c?.to ?? c?.validUntil) card.to = String(c.to ?? c.validUntil)
    return card
  }

  private assertDoor(door: number): void {
    if (!this.doors.includes(door)) throw new BadRequest(`controller "${this.id}" has no door ${door}`)
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
