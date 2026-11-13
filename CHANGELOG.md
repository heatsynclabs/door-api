# Changelog

## 0.1.0 (unreleased)

Initial release.

- One REST API (Fastify + TypeBox, OpenAPI at `/docs`) over multiple door
  controllers behind a `ControllerAdapter` driver layer.
- Drivers: `uhppote` (UHPPOTE/UT0311 family via the `uhppoted` UDP library —
  MENGQI, OBO HANDS, UHPPOTE, …), `openaccess` (legacy Open Access Arduino over
  its HTTP query protocol), `memory` (tests/dev).
- Tiered API-key auth (readonly/full), per-controller mutex (serialize) and
  circuit breaker, per-call timeouts, structured logging, health check.
- Card CRUD, `cards/sync` reconcile, door control (unlock/lock/open), events.
- OpenAccess driver verified against the firmware (26-bit Wiegand tag, mask
  1/255, slot ownership by tag, unauthenticated status, combined-login
  auto-logout, non-incremental event buffer).
