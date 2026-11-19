// The event-log journal. The Open Access board keeps a 40-entry buffer that is
// read with ?z and cleared with ?y; nothing else holds those events. A drain
// writes what ?z returned to disk (fsync'd) BEFORE ?y clears the board, and the
// entry stays until the members site says it has saved the rows (ack). So no
// event is lost if members times out, a deploy lands mid-import, or door-api
// restarts: the next drain hands back every unacknowledged entry first.
import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export interface DrainEntry {
  drain_id: string
  controller: string
  taken_at: string
  // The board's reply from "<pre>" on, byte for byte.
  raw: string
  // false if ?y was not confirmed: the board may still hold these events.
  cleared: boolean
}

export class Journal {
  // Without a directory (tests, sandboxes only) entries live in memory.
  private readonly memory = new Map<string, DrainEntry>()

  constructor(private readonly dir: string | null) {}

  get durable(): boolean {
    return this.dir != null
  }

  newId(): string {
    return `${new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 15)}-${randomUUID().slice(0, 8)}`
  }

  private file(controller: string, id: string): string {
    if (!/^[a-z0-9-]+$/.test(controller) || !/^[0-9]{8}-[0-9]{6}-[0-9a-f]{8}$/.test(id)) throw new Error('bad journal id')
    return join(this.dir!, `${controller}--${id}.json`)
  }

  async write(entry: DrainEntry): Promise<void> {
    if (!this.dir) {
      this.memory.set(entry.drain_id, entry)
      return
    }
    await mkdir(this.dir, { recursive: true })
    const final = this.file(entry.controller, entry.drain_id)
    const tmp = `${final}.tmp`
    const fh = await open(tmp, 'w', 0o600)
    try {
      await fh.writeFile(JSON.stringify(entry))
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, final)
    const dirh = await open(this.dir, 'r')
    try {
      await dirh.sync()
    } finally {
      await dirh.close()
    }
  }

  async pending(controller: string): Promise<DrainEntry[]> {
    if (!this.dir) return [...this.memory.values()].filter((e) => e.controller === controller).sort(byTime)
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return []
    }
    const out: DrainEntry[] = []
    for (const n of names) {
      if (!n.startsWith(`${controller}--`) || !n.endsWith('.json')) continue
      out.push(JSON.parse(await readFile(join(this.dir, n), 'utf8')) as DrainEntry)
    }
    return out.sort(byTime)
  }

  // Remove one acknowledged entry. Returns false if it was not there.
  async ack(controller: string, id: string): Promise<boolean> {
    if (!this.dir) {
      const e = this.memory.get(id)
      if (!e || e.controller !== controller) return false
      return this.memory.delete(id)
    }
    try {
      await unlink(this.file(controller, id))
      return true
    } catch {
      return false
    }
  }
}

function byTime(a: DrainEntry, b: DrainEntry): number {
  return a.taken_at < b.taken_at ? -1 : a.taken_at > b.taken_at ? 1 : a.drain_id < b.drain_id ? -1 : 1
}
