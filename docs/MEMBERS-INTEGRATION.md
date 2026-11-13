# Integrating the members site

This describes how the HeatSync members site
([Open-Source-Access-Control-Web-Interface](https://github.com/heatsynclabs/Open-Source-Access-Control-Web-Interface))
talks to door-api. The members app stays the **source of truth** for who has a
card; door-api keeps the board(s) in sync and reports what happened.

## What changes, and what doesn't

The members app already funnels all hardware access through two models (`Card`,
`DoorLog`) and a single `DoorBoard` seam. Integration swaps the body of that seam
for HTTP calls to door-api, behind a feature flag. Status and events stay
**DB-backed** (the app reads `DoorLog` rows), so the UI barely changes.

| Members action | Today | With door-api |
|---|---|---|
| create/update/enable/disable a card | `Card#upload_to_door` → board | `PUT /v1/controllers/:id/cards/:card` `{doors,from,to}` |
| upload all / reconcile | `Card.upload_all_to_door` | `POST /v1/controllers/:id/cards/sync` |
| delete a card | DB only (left on board) | also `DELETE …/cards/:card` |
| remote door control | `DoorLog.execute_command` | `POST …/doors/:door/{unlock,lock,open}` |
| board status | `DoorLog.download_status` → `DoorLog` rows | `GET …/status` → write the same `door_N_locked` rows |
| event log | `DoorLog.download_from_door` (read+clear) | UHPPOTE: `GET …/events?after=` → `DoorLog` rows. Legacy board: keep the native read+clear path |

## Mapping rules (get these exactly right)

- **Card number:** the members `card_number` is **hex**; door-api wants a **decimal**
  `card`. Send `card_number.to_i(16)`.
- **Permissions → doors:** `card_permissions == 1` (enabled) → the controller's
  door list; `255` (disabled) → `[]` (card present, no access).
- **Stat continuity:** the per-card "days used" stat matches `DoorLog` rows keyed
  `G` with `data = card_number.to_i(16) % 32767`. When writing rows from UHPPOTE
  events, compute `data = uhppote_card % 32767` — and this only lines up once
  `card_number` is migrated to the UHPPOTE convention (see ARCHITECTURE § migration gate).
- **Legacy events are not incremental.** Don't resume by index on the `openaccess`
  driver; keep the members app's existing drain-and-clear log path for the Arduino.

## Reliability contract

- **door-api down must not block a DB write.** Create/update the card in the DB,
  mark it `pending`, and reconcile later (a job + a periodic `cards/sync`). Show
  the per-card sync state in the UI.
- **The door password is load-bearing:** a wrong one locks the Arduino for 5
  minutes. Configure it once, correctly; never retry auth in a loop. Let door-api's
  circuit breaker hold off a failing board.
- **Auth:** members → door-api with a `full` API key (`Authorization: Bearer …`),
  over the LAN, ideally TLS. Keep the key out of source; inject at deploy.

## Config the members app needs

```
DOOR_API_URL   = http://door-api.lab:3000
DOOR_API_KEY   = <full-permission key>
DOOR_BACKEND   = legacy | door_api      # feature flag; default legacy
# door -> controller map, e.g. front -> {controller: "front", door: 1}
```

## Suggested rollout

1. Ship the client + flag with `DOOR_BACKEND=legacy` (no behavior change).
2. Bench-test against door-api with a `memory` controller, then a real board.
3. **Confirm the card-number convention with one physical card** before syncing
   real cards to UHPPOTE.
4. Flip one environment to `door_api`; watch; roll back by flipping the flag.
5. Once every door is on door-api, retire the direct-board code and the slot
   machinery (keep `cards#authorize` — interlocks).
