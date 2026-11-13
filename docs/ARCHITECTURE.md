# Architecture

door-api is a thin, well-tested HTTP service with one job: present **one REST API**
for door control, card management and events, and translate it to whatever
controller is actually on the wall through a **driver adapter**. Callers (the
members site) never speak a board's protocol.

```
caller ──HTTPS + API key──► door-api ──ControllerAdapter──► a controller
                            │  Fastify + TypeBox (validate + OpenAPI)
                            │  per-controller mutex (serialize) + opossum breaker
                            │  pino logs
                            └ drivers: uhppote | openaccess | memory
```

## The adapter contract

Every driver implements `ControllerAdapter` (`src/domain.ts`):

```ts
status(): Promise<ControllerStatus>
unlock(door) / lock(door) / open(door): Promise<void>
listCards() / getCard(n) / putCard(card) / deleteCard(n)
events(after, limit): Promise<EventPage>
```

The API keys everything by **card number** and **door number**; each adapter maps
that to its hardware. Adding a new board = one new file implementing this
interface + one `switch` case in `registry.ts`. Nothing else changes.

`reconcile.ts` builds `cards/sync` on top of the primitives (list once, write the
diff), so every adapter gets sync for free.

## Reliability

- **Per-controller mutex** (`registry.ts`): the legacy Arduino is a single-client
  HTTP server — overlapping requests interleave or fail, so all calls to one
  controller are serialized. `cards/sync` runs as one serialized batch.
- **Circuit breaker** (opossum, per controller): once calls to a board are
  failing, fast-fail with `503 circuit_open` instead of hammering it.
- **Timeouts** live in the adapters (fetch `AbortSignal.timeout`; the uhppoted
  `Config` timeout). Retries are **off** — a door command must not be silently
  repeated.

## The two real controllers

### `uhppote` — UHPPOTE / UT0311-L0x (MENGQI, OBO HANDS, UHPPOTE, …)

One OEM TCP-IP Wiegand board sold under many brands. Driven via the official
[`uhppoted`](https://github.com/uhppoted) Node library over UDP (port 60000).
Cards key by number, carry per-door rights and a validity window; the board holds
thousands of cards and a real event log read by index.

> **Security:** the UHPPOTE UDP protocol is **unauthenticated and cleartext** —
> anything that can reach the board on UDP/60000 can open a door or add a card.
> These controllers must live on an isolated **door VLAN**, reachable only by the
> door-api host. door-api is the single authenticated front door.

> **Unverified until hardware:** `getStatus`/`getEvent`/`getCard` field names are
> mapped defensively and kept raw in `details`. Confirm against the board or the
> [simulator](https://github.com/uhppoted/uhppote-simulator).

### `openaccess` — the legacy Open Access Arduino

HSL's fork of 23B/Arclight *Open Access Control* on an ATmega328 + W5100. Driven
over its raw HTTP query protocol. **These facts were verified by reading the
firmware** and the driver depends on them:

| Fact | Consequence for the driver |
|---|---|
| A card is stored as the **raw 26-bit Wiegand frame (parity bits included)**, as hex; `checkUser` matches that exact value | `card_number` on the members side is that 26-bit value in hex |
| **mask 1 → grant + unlock** (`default` case); **mask 255 → "Locked out"** | `putCard` writes mask 1 for access, 255 to disable |
| The board keys cards by **EEPROM slot** (0–199; slot 200 overflows the 1KB EEPROM) | the driver maps card number ↔ slot and allocates free slots itself |
| A **disabled** card keeps its real tag and still owns its slot | occupancy is decided by the tag, never the mask, or a new card would overwrite a disabled one |
| `?9` status needs **no login**; `?cmd&e=PW` logs in, runs, and **auto-logs-out** | status is unauthenticated; every privileged call carries `&e=PW` |
| **5 bad logins → 5-minute lockout** | the configured door password is load-bearing; never auth-retry in a loop |
| The event log is a **fixed circular buffer with no read cursor**, cleared by `?y`; a card is split across two half-entries (`G = n % 32767`, `g = n / 32767`) | `events()` here is best-effort and **non-incremental** — drain-and-clear on the members side instead of resuming by index |

## Card numbers across boards (the migration gate)

The Arduino stores the **raw 26-bit** Wiegand frame. UHPPOTE boards almost always
report the **24 data bits** (parity stripped). If so, the conversion is
deterministic:

```
uhppote_card = (parseInt(members.card_number, 16) >> 1) & 0x00FFFFFF
```

This **must be confirmed with one physical card** (read it on the UHPPOTE board,
compare to its members `card_number`) before syncing real cards. Outcomes:
identical (no migration), the formula above (convert at cutover), or something
else (re-enroll). You cannot serve both board types from one `card_number` column
if their conventions differ — migration picks one per card.

## What door-api is NOT responsible for

The **door controller decides access locally** from its own card table (both the
Arduino and UHPPOTE). It never calls back to the members site. The members app's
`cards#authorize` endpoint serves **tool/equipment interlocks** checking
certifications in real time — a separate concern, untouched by door-api.
