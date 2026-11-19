import { describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Queue } from '../src/registry.js'
import { Journal } from '../src/journal.js'
import { Busy } from '../src/errors.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('Queue', () => {
  it('runs calls one at a time, in order', async () => {
    const q = new Queue()
    const seen: string[] = []
    await Promise.all(
      ['a', 'b', 'c'].map((x) =>
        q.run(async () => {
          seen.push(`${x}+`)
          await sleep(20)
          seen.push(`${x}-`)
        })
      )
    )
    expect(seen).toEqual(['a+', 'a-', 'b+', 'b-', 'c+', 'c-'])
  })

  it('drops a door action that cannot start by its deadline, and never runs it later', async () => {
    const q = new Queue()
    let opened = false
    const slow = q.run(() => sleep(200))
    const open = q.run(async () => {
      opened = true
    }, 50)
    await expect(open).rejects.toBeInstanceOf(Busy)
    await slow
    await sleep(20)
    expect(opened).toBe(false)
    // and the queue still works afterwards
    expect(await q.run(async () => 'next', 50)).toBe('next')
  })

  it('never drops a call without a deadline (a lock waits its turn)', async () => {
    const q = new Queue()
    void q.run(() => sleep(100))
    let locked = false
    await q.run(async () => {
      locked = true
    })
    expect(locked).toBe(true)
  })

  it('keeps going after a call fails', async () => {
    const q = new Queue()
    await expect(q.run(() => Promise.reject(new Error('board said no')))).rejects.toThrow('board said no')
    expect(await q.run(async () => 1)).toBe(1)
  })
})

describe('Journal on disk', () => {
  it('survives a restart until each drain is acknowledged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'door-journal-'))
    try {
      const j1 = new Journal(dir)
      const a = { drain_id: j1.newId(), controller: 'front', taken_at: '2026-11-18T10:00:00.000Z', raw: '<pre>\r\nU: 1\r\n</pre>\r\n', cleared: true }
      const b = { ...a, drain_id: j1.newId(), taken_at: '2026-11-18T10:06:00.000Z' }
      await j1.write(b)
      await j1.write(a)
      const j2 = new Journal(dir) // a restarted service
      expect((await j2.pending('front')).map((d) => d.drain_id)).toEqual([a.drain_id, b.drain_id])
      expect(await j2.pending('other')).toEqual([])
      expect(await j2.ack('front', a.drain_id)).toBe(true)
      expect(await j2.ack('front', a.drain_id)).toBe(false)
      expect((await j2.pending('front')).map((d) => d.drain_id)).toEqual([b.drain_id])
      expect((await readdir(dir)).some((f) => f.endsWith('.tmp'))).toBe(false)
      await expect(j2.ack('front', '../../etc/passwd')).resolves.toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
