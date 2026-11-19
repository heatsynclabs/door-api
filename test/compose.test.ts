// The two production compose files must stay the same service, differing only
// in the door-lan network (and the header comment). Catches an edit to one that
// was not made to the other.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const body = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n')

describe('production compose files', () => {
  it('differ only in the door-lan network', () => {
    const isolated = body('docker-compose.production.yml')
    const lan = body('docker-compose.production-lan.yml')
    const stripped = isolated
      .replace('      door-lan:\n        ipv4_address: 172.22.110.240\n', '')
      .replace(/ {2}door-lan:\n {4}name: door-lan\n[\s\S]*$/, '')
    expect(stripped).toBe(lan)
    expect(isolated).toContain('ipv4_address: 172.22.110.240')
    expect(lan).not.toContain('door-lan')
    expect(isolated).toContain('parent: eno2')
  })

  it('keep the board password out of the controller JSON and publish only on loopback', () => {
    for (const f of ['docker-compose.production.yml', 'docker-compose.production-lan.yml']) {
      const s = body(f)
      expect(s).not.toMatch(/"password"/)
      const published = [...s.matchAll(/^\s+- "([^"]+)"$/gm)].map((m) => m[1])
      expect(published).toEqual(['127.0.0.1:3002:3000'])
      expect(s).not.toMatch(/DOOR_JOBS/)
      expect(s).toContain('CONTROLLER_PASSWORD_FRONT: ${CONTROLLER_PASSWORD_FRONT}')
    }
  })
})
