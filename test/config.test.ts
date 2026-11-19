import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

function env(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...overrides } as NodeJS.ProcessEnv
}

describe('config', () => {
  it('parses named, scoped API keys and the older key:scope form', () => {
    const k1 = 'a'.repeat(32)
    const k2 = 'b'.repeat(32)
    const k3 = 'c'.repeat(32)
    const c = loadConfig(env({ API_KEYS: `members-prod:${k1}:full, monitor:${k2}:readonly, ${k3}:door` }))
    expect(c.apiKeys.get(k1)).toEqual({ name: 'members-prod', scope: 'full' })
    expect(c.apiKeys.get(k2)).toEqual({ name: 'monitor', scope: 'readonly' })
    expect(c.apiKeys.get(k3)).toEqual({ name: 'key-3', scope: 'door' })
  })

  it('rejects an invalid scope, a short key and a repeated key', () => {
    const k = 'a'.repeat(32)
    expect(() => loadConfig(env({ API_KEYS: `x:${k}:admin` }))).toThrow(/invalid scope/)
    expect(() => loadConfig(env({ API_KEYS: 'x:short:full' }))).toThrow(/too short/)
    expect(() => loadConfig(env({ API_KEYS: `x:${k}:full,y:${k}:readonly` }))).toThrow(/repeats/)
  })

  it('takes an Open Access password from CONTROLLER_PASSWORD_<ID> and checks it is 4 hex digits', () => {
    const json = JSON.stringify([{ id: 'front', driver: 'openaccess', url: 'http://10.0.0.9', doors: [1, 2] }])
    expect(loadConfig(env({ CONTROLLERS_JSON: json, CONTROLLER_PASSWORD_FRONT: 'a1B2' })).controllers[0]?.password).toBe('a1B2')
    expect(() => loadConfig(env({ CONTROLLERS_JSON: json }))).toThrow(/needs CONTROLLER_PASSWORD_FRONT/)
    expect(() => loadConfig(env({ CONTROLLERS_JSON: json, CONTROLLER_PASSWORD_FRONT: '12345' }))).toThrow(/4 hex digits/)
  })

  it('rejects unknown keys, a URL carrying a query or credentials, and actions for a missing door', () => {
    const base = { id: 'front', driver: 'openaccess', url: 'http://10.0.0.9', password: '1234', doors: [1, 2] }
    expect(() => loadConfig(env({ CONTROLLERS_JSON: JSON.stringify([{ ...base, typo: 1 }]) }))).toThrow(/invalid/)
    expect(() => loadConfig(env({ CONTROLLERS_JSON: JSON.stringify([{ ...base, url: 'http://10.0.0.9/?e=1234' }]) }))).toThrow(/invalid/)
    expect(() => loadConfig(env({ CONTROLLERS_JSON: JSON.stringify([{ ...base, url: 'http://u:p@10.0.0.9' }]) }))).toThrow(/invalid/)
    expect(() => loadConfig(env({ CONTROLLERS_JSON: JSON.stringify([{ ...base, actions: { '3': ['open'] } }]) }))).toThrow(/door 3/)
    const ok = loadConfig(env({ CONTROLLERS_JSON: JSON.stringify([{ ...base, actions: { '2': ['open', 'lock'] } }]) }))
    expect(ok.controllers[0]?.actions).toEqual({ '2': ['open', 'lock'] })
  })

  it('loads controllers from CONTROLLERS_JSON', () => {
    const c = loadConfig(
      env({
        CONTROLLERS_JSON: JSON.stringify([
          { id: 'front', driver: 'uhppote', serial: 405419896, doors: [1, 2] },
          { id: 'rear', driver: 'openaccess', url: 'http://10.0.0.9', password: '1234', doors: [1, 2] }
        ])
      })
    )
    expect(c.controllers).toHaveLength(2)
    expect(c.controllers[0]).toMatchObject({ id: 'front', driver: 'uhppote', serial: 405419896 })
  })

  it('requires a serial for uhppote controllers', () => {
    expect(() =>
      loadConfig(env({ CONTROLLERS_JSON: JSON.stringify([{ id: 'x', driver: 'uhppote', doors: [1] }]) }))
    ).toThrow(/needs a serial/)
  })

  it('requires url and password for openaccess controllers', () => {
    expect(() =>
      loadConfig(env({ CONTROLLERS_JSON: JSON.stringify([{ id: 'x', driver: 'openaccess', doors: [1] }]) }))
    ).toThrow(/needs a url/)
  })

  it('rejects duplicate controller ids', () => {
    expect(() =>
      loadConfig(
        env({
          CONTROLLERS_JSON: JSON.stringify([
            { id: 'dup', driver: 'memory', doors: [1] },
            { id: 'dup', driver: 'memory', doors: [1] }
          ])
        })
      )
    ).toThrow(/duplicate controller id/)
  })

  it('rejects malformed controller JSON shape', () => {
    expect(() => loadConfig(env({ CONTROLLERS_JSON: JSON.stringify([{ id: 'x' }]) }))).toThrow(/invalid/)
  })

  it('runs door jobs unless DOOR_JOBS is off', () => {
    expect(loadConfig(env({})).doorJobs).toBe(true)
    expect(loadConfig(env({ DOOR_JOBS: 'on' })).doorJobs).toBe(true)
    expect(loadConfig(env({ DOOR_JOBS: ' OFF ' })).doorJobs).toBe(false)
  })

  it('accepts a sandbox flag on a controller', () => {
    const c = loadConfig(
      env({
        CONTROLLERS_JSON: JSON.stringify([
          { id: 'sim', driver: 'openaccess', url: 'http://door-sim:9099', password: '1234', doors: [1, 2], sandbox: true }
        ])
      })
    )
    expect(c.controllers[0]?.sandbox).toBe(true)
  })
})
