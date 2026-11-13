// Reconcile a controller's card table to a desired set. The members site is the
// source of truth; this makes the board match it. Reads the board once, then
// writes only the differences. Runs inside the controller mutex (see registry),
// so the whole reconcile is one serialized batch against the hardware.
import type { Card, ControllerAdapter } from './domain.js'

export interface SyncResult {
  added: number
  updated: number
  unchanged: number
  removed: number
  failed: { card: number; error: string }[]
}

function sameCard(a: Card, b: Card): boolean {
  const doorsA = [...a.doors].sort((x, y) => x - y).join(',')
  const doorsB = [...b.doors].sort((x, y) => x - y).join(',')
  return doorsA === doorsB && (a.from ?? '') === (b.from ?? '') && (a.to ?? '') === (b.to ?? '')
}

export async function reconcileCards(
  adapter: ControllerAdapter,
  desired: Card[],
  prune: boolean
): Promise<SyncResult> {
  const result: SyncResult = { added: 0, updated: 0, unchanged: 0, removed: 0, failed: [] }
  const current = await adapter.listCards()
  const currentByNumber = new Map(current.map((c) => [c.card, c]))
  const desiredByNumber = new Map(desired.map((c) => [c.card, c]))

  for (const card of desired) {
    try {
      const existing = currentByNumber.get(card.card)
      if (!existing) {
        await adapter.putCard(card)
        result.added += 1
      } else if (!sameCard(existing, card)) {
        await adapter.putCard(card)
        result.updated += 1
      } else {
        result.unchanged += 1
      }
    } catch (err) {
      result.failed.push({ card: card.card, error: (err as Error).message })
    }
  }

  if (prune) {
    for (const card of current) {
      if (desiredByNumber.has(card.card)) continue
      try {
        await adapter.deleteCard(card.card)
        result.removed += 1
      } catch (err) {
        result.failed.push({ card: card.card, error: (err as Error).message })
      }
    }
  }

  return result
}
