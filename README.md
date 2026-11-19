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

## Staging and production

### What runs where

| Branch | Coolify app (R610, project Critical Infra) | Address | Talks to |
|---|---|---|---|
| `staging` | `door-api-staging` (`iuyszttidtugr71nc9yn8yvy`), environment `staging`, compose file `docker-compose.staging.yml` | `http://172.22.110.200:3001` (LAN, VPN, tailnet) | `front`: the real front door board; `sim`: the simulator |
| `main` | `door-api-production` (`rormaiwrtppwwxc1mskrbk01`), environment `production`, compose file `docker-compose.production-lan.yml`, later `docker-compose.production.yml` | no LAN port; members reaches `http://door-api-prod:3000` on the internal `door-net` network; operators use `127.0.0.1:3002` on the R610 | `front`: the real front door board |

`door-api-production` exists in Coolify (created 2026-11-18) but is not deployed:
it goes live in the door cutover (operations folder,
`reference/door-cutover-runbook.md`, driven by `tools/door-cutover/go.py`). Until then
production members talks to the board directly, and members staging is the only
client of door-api staging.

### How a push deploys

A push to `staging` on GitHub sends a webhook (repo webhook `713424114`) to
`https://coolify.heatsynclabs.org/webhooks/source/github/events/manual`. Coolify
checks the signature and redeploys every app whose repo and branch match, so a
push to `staging` deploys `door-api-staging` and nothing else. Coolify builds the
image from this repo and starts the services in `docker-compose.staging.yml`.
Progress and logs: Coolify, project Critical Infra, environment `staging`,
app `door-api-staging`, Deployments.

### Flags and settings

In `docker-compose.staging.yml` (in git, so changing them is a reviewed commit):

- `DOOR_JOBS: "off"`. A second copy must never run production's door jobs. With it
  off, a real (non-sandbox) controller only takes status, open, unlock and lock.
  The event log, card sync and every single-card read or write answer
  `409 door_jobs_off`, and `/health` does not poll it. Unset means on.
- `CONTROLLERS_JSON`: `front` is the real board at `172.22.110.99`; `sim` is the
  simulator, marked `"sandbox": true`, where everything is allowed.

In Coolify, app `door-api-staging`, Environment Variables (secrets, never in git;
the values are recorded in the ops folder `secrets/SECRETS.md`, section 2):

- `API_KEYS`: the key members staging sends as `DOOR_API_KEY`.
- `BOARD_PASSWORD` (until the cutover; deleted by `go.py staging-to-sim`): the real board's password. Must be exactly production
  members' `DOOR_ACCESS_PASSWORD`. A wrong one fails the board's login, and 5
  failures lock every system out of the board for 5 minutes, production too.
  door-api treats the board's `authfail` reply as an error.
- `SIM_PASSWORD`: the simulator's password (not the board's).

### Making a change

1. Branch from `staging`, make the change, and run `npm test`, `npm run lint`,
   `npm run typecheck` and `npm run build`. Use the simulator
   (`npm run sim`, see above) for anything that touches a board.
2. Merge or push to `staging`. Coolify redeploys door-api staging in a minute or two.
3. Test through members staging (`https://staging.heatsynclabs.org`, remote door
   access) or call the API directly with the staging key. `front` moves the real
   front door, so tell people at the lab first. Use `sim` for card and log work.
4. When it is right, open a pull request from `staging` to `main`. Once production
   is live, merging it deploys door-api production: do it at a quiet minute (2 to 4
   past a 6-minute mark) and check `/log/pending` and the audit log afterwards.

### Production

- **Compose files.** `docker-compose.production-lan.yml` reaches the board over the
  lab LAN (before isolation, and the rollback). `docker-compose.production.yml` adds
  the `door-lan` macvlan network on the R610's eno2 with door-api at 172.22.110.240:
  the board's private segment. `test/compose.test.ts` keeps the two identical apart
  from that network. Switching is a change of the app's compose file location and a
  redeploy (`go.py isolate`, `go.py rollback isolation`).
- **Networks** (created once on the R610 by the operations folder's
  `tools/door-cutover/r610-prep.sh`): `door-net` (internal; members production joins
  it) and `door-lan` (macvlan, parent eno2).
- **Environment** (Coolify; values in the operations folder `secrets/SECRETS.md`):
  `API_KEYS` (`members-prod:<key>:full,ops-readonly:<key>:readonly`) and
  `CONTROLLER_PASSWORD_FRONT` (the board's password, the same value as members'
  `DOOR_ACCESS_PASSWORD`). `DOOR_JOBS` is unset: production owns the board's jobs.
- **Data volume** `door-api-data` at `/data`: the event-log journal (`/data/journal`)
  and the audit log (`/data/audit/door-actions.log`).
- **Checks on the R610** without sudo:
  `curl -H "Authorization: Bearer <ops-readonly key>" http://127.0.0.1:3002/v1/controllers/front/status`
  (also `/slots`, `/log/pending`). `/health` is liveness only and never touches the board.
- **A push to `main` deploys production door-api** (same webhook). Its commit pin
  must be `HEAD`; `go.py` sets it.

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

Done: `cards/sync` reconcile, per-controller serialization, circuit breaker, the
Arduino simulator + integration test, and the members-site `DoorApiClient` (on the
`door-api-integration` branch of the members repo, verified end-to-end against the
simulator).
