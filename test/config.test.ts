import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

function env(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...overrides } as NodeJS.ProcessEnv
}

describe('config', () => {
  it('parses tiered API keys', () => {
    const c = loadConfig(env({ API_KEYS: 'a:readonly, b:full' }))
    expect(c.apiKeys.get('a')).toBe('readonly')
    expect(c.apiKeys.get('b')).toBe('full')
  })

  it('rejects an invalid permission', () => {
    expect(() => loadConfig(env({ API_KEYS: 'a:admin' }))).toThrow(/invalid permission/)
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
    ).toThrow(/needs url and password/)
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
})
