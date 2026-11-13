// Integration test: the real OpenAccessAdapter driving the faithful Arduino
// simulator over HTTP. This is the closest thing to the physical board we can run
// in CI, and it exercises the parsing/slot logic against the exact firmware
// response strings the simulator reproduces.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { OpenAccessAdapter } from '../src/adapters/openaccess.js'

const SIM = fileURLToPath(new URL('../sim/arduino-openaccess.mjs', import.meta.url))
const PORT = 9400 + Math.floor(Math.random() * 400)
const BASE = `http://127.0.0.1:${PORT}`

let sim: ChildProcess
let adapter: OpenAccessAdapter

async function waitForSim(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${BASE}/?9`)
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('simulator did not start')
}

describe('OpenAccessAdapter against the Arduino simulator', () => {
  beforeAll(async () => {
    sim = spawn('node', [SIM], { env: { ...process.env, PORT: String(PORT), PASSWORD: '1234' }, stdio: 'ignore' })
    await waitForSim()
    adapter = new OpenAccessAdapter(
      { id: 'sim', driver: 'openaccess', url: BASE, password: '1234', doors: [1, 2] },
      3000
    )
  })
  afterAll(() => {
    sim.kill()
  })

  it('reports a fresh board as fully locked and empty', async () => {
    const status = await adapter.status()
    expect(status.online).toBe(true)
    expect(status.doors).toEqual([
      { door: 1, locked: true },
      { door: 2, locked: true }
    ])
    expect(await adapter.listCards()).toEqual([])
  })

  it('writes, reads, and round-trips a card through the board EEPROM', async () => {
    await adapter.putCard({ card: 0xabcd, doors: [1, 2] })
    expect(await adapter.getCard(0xabcd)).toEqual({ card: 0xabcd, doors: [1, 2] })
    expect(await adapter.listCards()).toContainEqual({ card: 0xabcd, doors: [1, 2] })
  })

  it('disables a card (empty doors) without freeing its slot', async () => {
    await adapter.putCard({ card: 0x1111, doors: [1] })
    await adapter.putCard({ card: 0x1111, doors: [] }) // disable in place
    const card = await adapter.getCard(0x1111)
    expect(card).toEqual({ card: 0x1111, doors: [] })
    // a brand-new card must not reuse the disabled slot
    await adapter.putCard({ card: 0x2222, doors: [1] })
    expect((await adapter.listCards()).map((c) => c.card)).toContain(0x1111)
  })

  it('unlocks and locks a door', async () => {
    await adapter.unlock(1)
    expect((await adapter.status()).doors.find((d) => d.door === 1)?.locked).toBe(false)
    await adapter.lock(1)
    expect((await adapter.status()).doors.find((d) => d.door === 1)?.locked).toBe(true)
  })

  it('deletes a card', async () => {
    await adapter.putCard({ card: 0x9999, doors: [1] })
    await adapter.deleteCard(0x9999)
    expect(await adapter.getCard(0x9999)).toBeNull()
  })

  it('sees a swipe in the event log', async () => {
    await adapter.putCard({ card: 0xabcd, doors: [1, 2] })
    await fetch(`${BASE}/sim/swipe?card=ABCD`) // granted
    await fetch(`${BASE}/sim/swipe?card=DEAD`) // denied (not on board)
    const page = await adapter.events(0, 50)
    const types = page.events.map((e) => e.type)
    expect(types).toContain('granted')
    expect(types).toContain('denied')
  })
})
