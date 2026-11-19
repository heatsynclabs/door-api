// The audit trail: one JSON line per door, alarm, card or log action, with the
// API key's name and the X-Door-Actor the caller sends (informational: the
// caller sets it). Written to the service log and, if AUDIT_FILE is set, appended
// to that file on the data volume.
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { FastifyBaseLogger } from 'fastify'

export interface AuditRecord {
  key: string
  actor?: string
  controller: string
  action: string
  door?: number
  slot?: number
  result: 'ok' | 'refused' | 'error'
  error?: string
}

export class Audit {
  constructor(
    private readonly file: string | null,
    private readonly log: FastifyBaseLogger
  ) {}

  async record(r: AuditRecord): Promise<void> {
    const line = { at: new Date().toISOString(), ...r }
    this.log.info({ audit: line }, 'door audit')
    if (!this.file) return
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await appendFile(this.file, JSON.stringify(line) + '\n', { mode: 0o600 })
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'could not write the audit file')
    }
  }
}
