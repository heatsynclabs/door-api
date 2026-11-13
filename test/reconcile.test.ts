import { describe, expect, it } from 'vitest'
import { MemoryAdapter } from '../src/adapters/memory.js'
import { reconcileCards } from '../src/reconcile.js'

function adapter() {
  return new MemoryAdapter({ id: 'bench', driver: 'memory', doors: [1, 2] })
}

describe('reconcileCards', () => {
  it('adds, updates, leaves unchanged, and (optionally) prunes', async () => {
    const a = adapter()
    await a.putCard({ card: 100, doors: [1] }) // will be updated
    await a.putCard({ card: 200, doors: [1, 2] }) // unchanged
    await a.putCard({ card: 999, doors: [1] }) // not desired -> prune candidate

    const desired = [
      { card: 100, doors: [1, 2] }, // changed doors -> update
      { card: 200, doors: [1, 2] }, // same -> unchanged
      { card: 300, doors: [2] } // new -> add
    ]

    const result = await reconcileCards(a, desired, true)
    expect(result).toMatchObject({ added: 1, updated: 1, unchanged: 1, removed: 1, failed: [] })

    const cards = (await a.listCards()).map((c) => c.card).sort((x, y) => x - y)
    expect(cards).toEqual([100, 200, 300]) // 999 pruned
  })

  it('does not prune when prune is false', async () => {
    const a = adapter()
    await a.putCard({ card: 999, doors: [1] })
    const result = await reconcileCards(a, [{ card: 1, doors: [1] }], false)
    expect(result.removed).toBe(0)
    expect((await a.listCards()).map((c) => c.card).sort((x, y) => x - y)).toEqual([1, 999])
  })

  it('records per-card failures without aborting the batch', async () => {
    const a = adapter()
    // door 3 does not exist on this controller -> putCard throws BadRequest
    const result = await reconcileCards(a, [{ card: 1, doors: [1] }, { card: 2, doors: [3] }], false)
    expect(result.added).toBe(1)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]!.card).toBe(2)
  })
})
