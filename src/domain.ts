// The domain model and the adapter contract. Everything the API speaks is keyed
// by card NUMBER and door NUMBER, so the two very different controllers (UHPPOTE
// and the legacy Open Access Arduino) present one shape. Each adapter maps that
// to its own hardware (the Arduino keys cards by EEPROM slot, for instance).
import { Type, type Static } from '@sinclair/typebox'

export const DRIVERS = ['uhppote', 'openaccess', 'memory'] as const
export type DriverName = (typeof DRIVERS)[number]

// A card as the API speaks it.
export const CardSchema = Type.Object(
  {
    card: Type.Integer({ minimum: 1, description: 'Card number as the reader reports it (decimal).' }),
    doors: Type.Array(Type.Integer({ minimum: 1, maximum: 4 }), {
      description: 'Doors on this controller the card may open.'
    }),
    from: Type.Optional(Type.String({ description: 'Valid-from date YYYY-MM-DD (UHPPOTE only; ignored by the Arduino).' })),
    to: Type.Optional(Type.String({ description: 'Valid-until date YYYY-MM-DD (UHPPOTE only; ignored by the Arduino).' }))
  }
)
export type Card = Static<typeof CardSchema>

export const DoorStateSchema = Type.Object({
  door: Type.Integer(),
  open: Type.Optional(Type.Boolean()),
  locked: Type.Optional(Type.Boolean()),
  button: Type.Optional(Type.Boolean())
})
export type DoorState = Static<typeof DoorStateSchema>

export const ControllerStatusSchema = Type.Object(
  {
    id: Type.String(),
    driver: Type.String(),
    online: Type.Boolean(),
    doors: Type.Array(DoorStateSchema),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
  }
)
export type ControllerStatus = Static<typeof ControllerStatusSchema>

export const DoorEventSchema = Type.Object(
  {
    index: Type.Integer(),
    timestamp: Type.Union([Type.String(), Type.Null()]),
    type: Type.String(),
    door: Type.Optional(Type.Integer()),
    card: Type.Optional(Type.Integer()),
    granted: Type.Optional(Type.Boolean()),
    reason: Type.Optional(Type.String())
  }
)
export type DoorEvent = Static<typeof DoorEventSchema>

export interface EventPage {
  events: DoorEvent[]
  first: number
  last: number
}

// The one interface every controller driver implements. Methods throw the typed
// errors in errors.ts (Unreachable, NotFound, BadRequest); the route layer turns
// those into HTTP responses.
export interface ControllerAdapter {
  readonly id: string
  readonly driver: DriverName
  readonly doors: number[]

  status(): Promise<ControllerStatus>

  unlock(door: number): Promise<void>
  lock(door: number): Promise<void>
  open(door: number): Promise<void>

  listCards(): Promise<Card[]>
  getCard(card: number): Promise<Card | null>
  putCard(card: Card): Promise<void>
  deleteCard(card: number): Promise<void>

  events(after: number, limit: number): Promise<EventPage>
}
