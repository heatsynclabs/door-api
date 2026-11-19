// Configuration: server/env settings plus the list of controllers. Controllers
// are defined as JSON (a file named by CONTROLLERS_FILE, or inline in
// CONTROLLERS_JSON) so adding a board is config, not code. Everything is
// validated up front and the process refuses to start on a bad config.
//
// Board passwords do not belong in that JSON: an Open Access controller with
// id "front" takes its password from CONTROLLER_PASSWORD_FRONT. (A "password"
// key in the JSON still works, for older setups.)
import { readFileSync } from 'node:fs'
import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { DRIVERS } from './domain.js'

// readonly: status and reads. door: also door actions and the alarm.
// full: also cards and the event log.
export type Scope = 'readonly' | 'door' | 'full'
export const SCOPES: readonly Scope[] = ['readonly', 'door', 'full']

export interface ApiKey {
  name: string
  scope: Scope
}

export const DOOR_ACTIONS = ['open', 'unlock', 'lock'] as const
export type DoorAction = (typeof DOOR_ACTIONS)[number]

const ControllerConfigSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,31}$', description: 'Stable name used in the URL, e.g. "front".' }),
    driver: Type.Union(DRIVERS.map((d) => Type.Literal(d))),
    doors: Type.Array(Type.Integer({ minimum: 1, maximum: 4 }), { minItems: 1 }),
    // uhppote
    serial: Type.Optional(Type.Integer({ description: 'UHPPOTE controller serial number.' })),
    address: Type.Optional(Type.String({ description: 'UHPPOTE controller IP (optional; broadcast is used otherwise).' })),
    // openaccess
    url: Type.Optional(
      Type.String({ pattern: '^https?://[^\\s?#@]+$', description: 'Open Access Arduino base URL, e.g. http://172.22.110.99' })
    ),
    password: Type.Optional(Type.String({ description: 'Prefer CONTROLLER_PASSWORD_<ID>. 4 hex digits.' })),
    slotMin: Type.Optional(Type.Integer({ minimum: 0, maximum: 199 })),
    slotMax: Type.Optional(Type.Integer({ minimum: 0, maximum: 199 })),
    // Which actions each door takes, e.g. {"2": ["open", "lock"]}. A door not
    // listed takes every action.
    actions: Type.Optional(
      Type.Record(Type.String({ pattern: '^[1-4]$' }), Type.Array(Type.Union(DOOR_ACTIONS.map((a) => Type.Literal(a)))))
    ),
    // A simulator or bench board. DOOR_JOBS=off does not restrict it.
    sandbox: Type.Optional(Type.Boolean({ description: 'A simulator or test board, not a real door.' }))
  },
  { additionalProperties: false }
)
export type ControllerConfig = Static<typeof ControllerConfigSchema>

const ControllersSchema = Type.Array(ControllerConfigSchema)

export interface Config {
  host: string
  port: number
  env: string
  logLevel: string
  // False on a second copy (staging): see doorJobsEnabled.
  doorJobs: boolean
  apiKeys: Map<string, ApiKey>
  controllers: ControllerConfig[]
  timeouts: {
    hardware: number // per call to a controller, ms
    server: number // whole request, ms
    doorActionDeadline: number // open/unlock must start within this, ms
  }
  // How long privileged calls to a board stop after it refuses the password.
  // Longer than the firmware's 5-minute lockout window.
  authPauseMs: number
  // Where the event-log journal and the audit log are written (a volume).
  journalDir: string | null
  auditFile: string | null
  circuit: {
    enabled: boolean
    errorThresholdPercentage: number
    resetTimeout: number
    volumeThreshold: number
  }
  uhppote: {
    bind: string
    broadcast: string
    listen: string
  }
}

// API_KEYS is a comma-separated list of `name:key:scope` entries. The older
// `key:scope` form still works (named key-1, key-2, ...), and its "full" and
// "readonly" mean the same as before.
export function parseApiKeys(raw: string | undefined): Map<string, ApiKey> {
  const keys = new Map<string, ApiKey>()
  if (!raw || raw.trim() === '') return keys
  raw.split(',').forEach((entry, i) => {
    const parts = entry.split(':').map((s) => s.trim())
    let name: string | undefined
    let key: string | undefined
    let scope: string | undefined
    if (parts.length === 2) {
      ;[key, scope] = parts
      name = `key-${i + 1}`
    } else if (parts.length === 3) {
      ;[name, key, scope] = parts
    }
    if (!name || !key || !scope) throw new Error(`invalid API_KEYS entry ${i + 1} (expected name:key:scope)`)
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) throw new Error(`invalid API key name "${name}"`)
    if (key.length < 24) throw new Error(`API key "${name}" is too short (24 characters minimum)`)
    if (!SCOPES.includes(scope as Scope)) throw new Error(`invalid scope "${scope}" for key "${name}" (readonly, door or full)`)
    if (keys.has(key)) throw new Error(`API key "${name}" repeats another key`)
    keys.set(key, { name, scope: scope as Scope })
  })
  return keys
}

export function passwordEnvName(id: string): string {
  return `CONTROLLER_PASSWORD_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

function loadControllers(env: NodeJS.ProcessEnv): ControllerConfig[] {
  let raw: string
  if (env.CONTROLLERS_JSON && env.CONTROLLERS_JSON.trim() !== '') {
    raw = env.CONTROLLERS_JSON
  } else if (env.CONTROLLERS_FILE && env.CONTROLLERS_FILE.trim() !== '') {
    raw = readFileSync(env.CONTROLLERS_FILE, 'utf8')
  } else {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`controllers config is not valid JSON: ${(e as Error).message}`, { cause: e })
  }

  if (!Value.Check(ControllersSchema, parsed)) {
    const first = [...Value.Errors(ControllersSchema, parsed)][0]
    throw new Error(`controllers config is invalid: ${first?.path} ${first?.message}`)
  }

  const controllers = parsed as ControllerConfig[]
  const ids = new Set<string>()
  for (const c of controllers) {
    if (ids.has(c.id)) throw new Error(`duplicate controller id "${c.id}"`)
    ids.add(c.id)
    if (c.driver === 'uhppote' && c.serial == null) {
      throw new Error(`controller "${c.id}" (uhppote) needs a serial`)
    }
    if (c.driver === 'openaccess') {
      const fromEnv = env[passwordEnvName(c.id)]
      if (fromEnv != null && fromEnv.trim() !== '') c.password = fromEnv.trim()
      if (!c.url) throw new Error(`controller "${c.id}" (openaccess) needs a url`)
      if (!c.password) throw new Error(`controller "${c.id}" (openaccess) needs ${passwordEnvName(c.id)}`)
      if (!/^[0-9A-Fa-f]{4}$/.test(c.password)) {
        throw new Error(`controller "${c.id}": the board password must be 4 hex digits`)
      }
      if ((c.slotMin ?? 0) > (c.slotMax ?? 199)) throw new Error(`controller "${c.id}": slotMin is above slotMax`)
    }
    for (const door of Object.keys(c.actions ?? {})) {
      if (!c.doors.includes(Number(door))) throw new Error(`controller "${c.id}": actions for door ${door}, which it does not have`)
    }
  }
  return controllers
}

function int(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n)) throw new Error(`expected an integer, got "${raw}"`)
  return n
}

function path(raw: string | undefined): string | null {
  return raw == null || raw.trim() === '' ? null : raw.trim()
}

// Door jobs are the work only one system may do against a real board: reading
// its event log, reconciling its whole card table, and the health probe that
// polls every controller on a timer. Production leaves DOOR_JOBS unset; a
// staging copy sets DOOR_JOBS=off. Single door and card actions still work, and
// sandbox controllers (the memory driver, or "sandbox": true) are never limited.
export function doorJobsEnabled(raw: string | undefined): boolean {
  return (raw ?? '').trim().toLowerCase() !== 'off'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST ?? '0.0.0.0',
    port: int(env.PORT, 3000),
    env: env.NODE_ENV ?? 'development',
    logLevel: env.LOG_LEVEL ?? 'info',
    doorJobs: doorJobsEnabled(env.DOOR_JOBS),
    apiKeys: parseApiKeys(env.API_KEYS),
    controllers: loadControllers(env),
    timeouts: {
      hardware: int(env.HARDWARE_TIMEOUT, 10_000),
      server: int(env.SERVER_TIMEOUT, 30_000),
      doorActionDeadline: int(env.DOOR_ACTION_DEADLINE, 3_000)
    },
    authPauseMs: int(env.AUTH_PAUSE_MS, 6 * 60_000),
    journalDir: path(env.JOURNAL_DIR),
    auditFile: path(env.AUDIT_FILE),
    circuit: {
      enabled: env.CIRCUIT_BREAKER_ENABLED !== 'false',
      errorThresholdPercentage: int(env.CIRCUIT_BREAKER_ERROR_THRESHOLD, 50),
      resetTimeout: int(env.CIRCUIT_BREAKER_RESET_TIMEOUT, 60_000),
      volumeThreshold: int(env.CIRCUIT_BREAKER_VOLUME_THRESHOLD, 5)
    },
    uhppote: {
      bind: env.UHPPOTE_BIND ?? '0.0.0.0',
      broadcast: env.UHPPOTE_BROADCAST ?? '255.255.255.255:60000',
      listen: env.UHPPOTE_LISTEN ?? '0.0.0.0:60001'
    }
  }
}
