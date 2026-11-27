import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IndexerManager, type IndexerStoreShape } from '../src/main/indexers'
import { JsonStore } from '../src/main/store'

// Only the hand-written trackers (no definition folders) and a network that's down
const offline = { request: async () => Promise.reject(new Error('fetch failed')) } as never

async function manager(store = new JsonStore<IndexerStoreShape>(join(mkdtempSync(join(tmpdir(), 'ix-')), 's.json'), { indexers: {} })) {
  const m = new IndexerManager([], offline, store, async () => 'closed')
  await m.load()
  return { m, store }
}

describe('tracker auto-management', () => {
  it('changes nothing when the check runs offline, however often', async () => {
    const { m } = await manager()
    const before = m.list().filter((i) => i.enabled).map((i) => i.id)
    expect(before.length).toBeGreaterThan(0)
    for (let i = 0; i < 3; i++) await m.checkAll(['en'], { manage: true })
    expect(m.list().filter((i) => i.enabled).map((i) => i.id)).toEqual(before)
  })

  it('turns trackers back on when an earlier version switched them all off', async () => {
    const { m, store } = await manager()
    for (const i of m.list()) store.update((d) => (d.indexers[i.id] = { enabled: false, values: {}, fails: 3 }))
    expect(m.list().filter((i) => i.enabled)).toHaveLength(0)
    // Next start
    const again = await manager(store)
    expect(again.m.list().filter((i) => i.enabled).length).toBeGreaterThan(0)
  })

  it('reset brings the recommended set back and keeps priorities', async () => {
    const { m } = await manager()
    for (const i of m.list()) m.setEnabled(i.id, false)
    m.setPriority('ext', 'high')
    const after = m.resetToDefaults()
    expect(after.filter((i) => i.enabled).length).toBeGreaterThan(0)
    expect(after.find((i) => i.id === 'ext')?.priority).toBe('high')
  })
})
