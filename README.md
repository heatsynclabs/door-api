# door-api

One sensible REST API over HeatSync's door controllers, whatever they happen to
be. The members site (and anything else) talks to this service; this service
talks to the hardware through a small **driver adapter** per controller. Swapping
a board out later means writing one adapter, not touching the members site.

It speaks two controllers today:

- **`uhppote`** — UHPPOTE / UT0311-L0x TCP-IP Wiegand boards. These are one OEM
  design sold under many names (UHPPOTE, **MENGQI-CONTROL**, **OBO HANDS**,
  VBESTLIFE, …); the driver uses the official [`uhppoted`](https://github.com/uhppoted)
  UDP library, so any board in that family should work. Cards are keyed by card
  number, with per-door rights and a validity window. Holds thousands of cards and
  an on-board event log.
- **`openaccess`** — the legacy Open Access Arduino board
  ([zyphlar/Open_Access_Control_Ethernet](https://github.com/zyphlar/Open_Access_Control_Ethernet)),
  via its raw HTTP query protocol. Cards live in EEPROM slots (10–200); the
  adapter does the slot bookkeeping the members app used to do by hand.
- **`memory`** — an in-memory fake for local development and tests (no hardware).

Prior art: this generalizes HeatSync's earlier Node/Hapi `door-api` (API-key
tiers, circuit breaker, per-layer timeouts, structured logging, health, Swagger).
Those ideas are kept; the surface is widened to multiple controllers, card
management, and events.

## Architecture

```
members site ──HTTPS + API key──► door-api ──adapter──► controller(s) on the door VLAN
                                   │ Fastify + TypeBox (validation + OpenAPI)
                                   │ opossum circuit breaker per controller
                                   │ pino structured logs
                                   └ driver layer:
                                       UhppoteAdapter   (uhppoted UDP lib)
                                       OpenAccessAdapter (Arduino HTTP)
                                       MemoryAdapter    (tests / dev)
```

Every adapter implements one interface (`src/domain.ts` → `ControllerAdapter`):
`status`, `unlock`/`lock`/`open`, `listCards`/`getCard`/`putCard`/`deleteCard`,
`events`. The API is identical no matter which board is behind it.

## API

Auth: `Authorization: Bearer <key>`. Keys are `readonly` (status/cards/events) or
`full` (everything, incl. opening doors and writing cards). `GET /health` needs
no auth. Interactive docs at **`/docs`** (OpenAPI at `/docs/json`).

| Method | Path | Perm | |
|---|---|---|---|
| GET | `/health` | — | liveness + per-controller reachability + circuit state |
| GET | `/v1/controllers` | readonly | list configured controllers |
| GET | `/v1/controllers/:id/status` | readonly | controller + door status |
| POST | `/v1/controllers/:id/doors/:door/unlock` | full | hold a door unlocked |
| POST | `/v1/controllers/:id/doors/:door/lock` | full | lock a door |
| POST | `/v1/controllers/:id/doors/:door/open` | full | momentary release |
| GET | `/v1/controllers/:id/cards` | readonly | list cards on the board |
| GET | `/v1/controllers/:id/cards/:card` | readonly | one card |
| PUT | `/v1/controllers/:id/cards/:card` | full | create/update a card (idempotent) |
| DELETE | `/v1/controllers/:id/cards/:card` | full | remove a card |
| POST | `/v1/controllers/:id/cards/sync` | full | reconcile the board to a desired set (reads once, writes deltas; `prune` removes extras) |
| GET | `/v1/controllers/:id/events?after=&limit=` | readonly | events since an index |

`PUT` body: `{ "doors": [1,2], "from": "2026-01-01", "to": "2099-12-31" }`
(`from`/`to` are UHPPOTE-only; the Arduino ignores them).

## Configure

Settings come from the environment (see `.env.example`). Controllers are JSON —
a file named by `CONTROLLERS_FILE`, or inline in `CONTROLLERS_JSON` — see
`controllers.example.json`.

```json
[
  { "id": "front", "driver": "uhppote", "serial": 405419896, "address": "172.22.120.10", "doors": [1, 2] },
  { "id": "rear-legacy", "driver": "openaccess", "url": "http://172.22.110.99", "password": "1234", "doors": [1, 2] }
]
```

## Run

```bash
npm install
cp .env.example .env            # set API_KEYS; point CONTROLLERS_FILE at your JSON
npm run dev                     # tsx watch, pretty logs
# or
npm run build && npm start      # compiled dist/
# or
docker compose up --build
```

## Test

```bash
npm test          # vitest: config, routes (full stack via inject), adapters
npm run typecheck
```

Tests use the `memory` adapter and a fake Arduino HTTP server — no hardware.
For UHPPOTE, the project's [simulator](https://github.com/uhppoted/uhppote-simulator)
is the on-bench integration check (see roadmap).

### Arduino simulator

`npm run sim` starts a faithful emulator of the legacy Open Access Arduino board
(`sim/arduino-openaccess.mjs`) on port 9099: the real query protocol, EEPROM slot
model, privileged-mode login with auto-logout, status JSON, and the circular event
log (the `G/g` split on `% 32767`), plus `/sim/swipe?card=<hex>` and `/sim/state`
to drive and inspect it. `test/sim-integration.test.ts` runs the `openaccess`
driver against it, and it backs the end-to-end members-site tests. Point a
controller at it with `{"driver":"openaccess","url":"http://127.0.0.1:9099","password":"1234"}`.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the adapter design, the
  firmware facts the OpenAccess driver relies on, and the card-number migration gate.
- [`docs/MEMBERS-INTEGRATION.md`](docs/MEMBERS-INTEGRATION.md) — exactly how the
  members site talks to this service (the contract, the mapping rules, rollout).

## Security notes (read before deploying)

- **Isolate the controllers.** The UHPPOTE UDP protocol is **unauthenticated and
  cleartext** — any host that can reach the board on UDP/60000 can open a door or
  add a card. Put the controllers on a dedicated **door VLAN** and allow only this
  service to reach them. This API is the only authenticated front door.
- **UDP broadcast + containers.** UHPPOTE discovery/commands use UDP broadcast on
  `:60000`. In Docker that usually needs `network_mode: host` (with the host on
  the door VLAN), or a per-controller `address` so packets are sent directed.
- Keep `API_KEYS` out of the image; inject at deploy. Front with TLS.

## Roadmap / TODO

- **Verify against hardware:** confirm the MENGQI / OBO HANDS board answers the
  UHPPOTE protocol (`uhppote-cli get-devices` / the simulator), pin the exact
  `getStatus`/`getEvent` field names, and settle the card-number convention with
  one physical card (see ARCHITECTURE § migration gate).
- Event push: subscribe to UHPPOTE events (`uhppoted.listen`) and stream into the
  members DB, so an unknown swipe shows up instantly.
- `POST /v1/controllers/:id/snapshot` — backup-before-change.
- Members-site `DoorApiClient` (in progress on the members repo).

Done: `cards/sync` reconcile, per-controller serialization, circuit breaker.
