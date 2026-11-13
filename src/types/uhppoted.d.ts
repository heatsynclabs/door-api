// Minimal ambient declarations for the `uhppoted` npm package (plain JS, no types
// shipped). Only the functions this service calls are declared. Responses are
// left as `unknown`/`any` on purpose: the adapter maps them defensively.
declare module 'uhppoted' {
  export class Config {
    constructor(
      name: string,
      bind: string,
      broadcast: string,
      listen: string,
      timeout: number,
      devices: unknown[],
      debug: boolean
    )
  }

  export interface Ctx {
    config: Config
  }

  export type ControllerRef =
    | number
    | { controller: number; address?: string; protocol?: 'udp' | 'tcp' }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Resp = Promise<any>

  export function getDevice(ctx: Ctx, controller: ControllerRef): Resp
  export function getStatus(ctx: Ctx, controller: ControllerRef): Resp
  export function getDoorControl(ctx: Ctx, controller: ControllerRef, door: number): Resp
  export function setDoorControl(ctx: Ctx, controller: ControllerRef, door: number, delay: number, mode: number): Resp
  export function openDoor(ctx: Ctx, controller: ControllerRef, door: number): Resp
  export function getCards(ctx: Ctx, controller: ControllerRef): Resp
  export function getCard(ctx: Ctx, controller: ControllerRef, cardNumber: number): Resp
  export function getCardByIndex(ctx: Ctx, controller: ControllerRef, index: number): Resp
  export function putCard(
    ctx: Ctx,
    controller: ControllerRef,
    cardNumber: number,
    validFrom: string,
    validUntil: string,
    doors: Record<number, boolean | number>
  ): Resp
  export function deleteCard(ctx: Ctx, controller: ControllerRef, cardNumber: number): Resp
  export function getEvents(ctx: Ctx, controller: ControllerRef): Resp
  export function getEvent(ctx: Ctx, controller: ControllerRef, index: number): Resp
  export function setTime(ctx: Ctx, controller: ControllerRef, datetime: string): Resp

  interface Uhppoted {
    Config: typeof Config
    getDevice: typeof getDevice
    getStatus: typeof getStatus
    getDoorControl: typeof getDoorControl
    setDoorControl: typeof setDoorControl
    openDoor: typeof openDoor
    getCards: typeof getCards
    getCard: typeof getCard
    getCardByIndex: typeof getCardByIndex
    putCard: typeof putCard
    deleteCard: typeof deleteCard
    getEvents: typeof getEvents
    getEvent: typeof getEvent
    setTime: typeof setTime
  }

  const uhppoted: Uhppoted
  export default uhppoted
}
