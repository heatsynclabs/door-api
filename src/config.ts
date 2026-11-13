// Configuration: server/env settings plus the list of controllers. Controllers
// are defined as JSON (a file named by CONTROLLERS_FILE, or inline in
// CONTROLLERS_JSON) so adding a board is config, not code. Everything is
// validated up front and the process refuses to start on a bad config.
import { readFileSync } from 'node:fs'
import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { DRIVERS } from './domain.js'

export type Permission = 'readonly' | 'full'

const ControllerConfigSchema = Type.Object({
  id: Type.String({ minLength: 1, description: 'Stable name used in the URL, e.g. "front".' }),
  driver: Type.Union(DRIVERS.map((d) => Type.Literal(d))),
  doors: Type.Array(Type.Integer({ minimum: 1, maximum: 4 }), { minItems: 1 }),
  // uhppote
  serial: Type.Optional(Type.Integer({ description: 'UHPPOTE controller serial number.' })),
  address: Type.Optional(Type.String({ description: 'UHPPOTE controller IP (optional; broadcast is used otherwise).' })),
  // openaccess
  url: Type.Optional(Type.String({ description: 'Open Access Arduino base URL, e.g. http://172.22.110.99' })),
  password: Type.Optional(Type.String({ description: 'Open Access privileged-mode password (4 hex digits).' })),
  slotMin: Type.Optional(Type.Integer({ minimum: 0, maximum: 199 })),
  slotMax: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 }))
})
export type ControllerConfig = Static<typeof ControllerConfigSchema>

const ControllersSchema = Type.Array(ControllerConfigSchema)

export interface Config {
  host: string
  port: number
  env: string
  logLevel: string
  apiKeys: Map<string, Permission>
  controllers: ControllerConfig[]
  timeouts: {
    hardware: number // per call to a controller, ms
    server: number // whole request, ms
  }
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

function parseApiKeys(raw: string | undefined): Map<string, Permission> {
  const keys = new Map<string, Permission>()
  if (!raw || raw.trim() === '') return keys
  for (const pair of raw.split(',')) {
    const [key, perm] = pair.split(':').map((s) => s.trim())
    if (!key || !perm) throw new Error(`invalid API_KEYS entry "${pair}" (expected key:permission)`)
    if (perm !== 'readonly' && perm !== 'full') {
      throw new Error(`invalid permission "${perm}" for a key (must be readonly or full)`)
    }
    keys.set(key, perm)
  }
  return keys
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
    if (c.driver === 'openaccess' && (!c.url || !c.password)) {
      throw new Error(`controller "${c.id}" (openaccess) needs url and password`)
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST ?? '0.0.0.0',
    port: int(env.PORT, 3000),
    env: env.NODE_ENV ?? 'development',
    logLevel: env.LOG_LEVEL ?? 'info',
    apiKeys: parseApiKeys(env.API_KEYS),
    controllers: loadControllers(env),
    timeouts: {
      hardware: int(env.HARDWARE_TIMEOUT, 10_000),
      server: int(env.SERVER_TIMEOUT, 30_000)
    },
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
