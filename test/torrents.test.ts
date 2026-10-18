import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebTorrent from 'webtorrent'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonStore } from '../src/main/store'
import { TorrentManager, type TorrentStoreShape } from '../src/main/torrents'

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p))
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c()
})

describe('torrent manager', () => {
  // WebTorrent emits a file's 'done' from inside its own loop and keeps using the torrent
  // afterwards; pausing right there (seeding off) used to crash the main process.
  it('finishes and pauses a torrent when seeding is off', async () => {
    const crashes: unknown[] = []
    const onCrash = (e: unknown) => crashes.push(e)
    process.on('uncaughtException', onCrash)
    cleanup.push(() => void process.off('uncaughtException', onCrash))

    const seeder = new WebTorrent({ dht: false, tracker: false, lsd: false })
    cleanup.push(() => new Promise<void>((r) => seeder.destroy(() => r())))
    const data = Object.assign(randomBytes(200_000), { name: 'a.bin' })
    const seeded = await new Promise<{ magnetURI: string; infoHash: string }>((resolve) => seeder.seed(data as never, { path: tmp('seed-') } as never, resolve as never))

    const store = new JsonStore<TorrentStoreShape>(join(tmp('store-'), 's.json'), { torrents: [] })
    let completed = 0
    const mgr = new TorrentManager(store, tmp('meta-'), { seedAfterDownload: () => false, onComplete: () => completed++ })
    cleanup.push(() => mgr.destroy())
    await mgr.init()
    await mgr.add({ kind: 'magnet', uri: seeded.magnetURI }, tmp('dl-'))
    // No trackers or DHT here: introduce the seeder directly
    const live = (mgr as unknown as { live: Map<string, { addPeer(a: string): void }> }).live.get(seeded.infoHash)!
    live.addPeer(`127.0.0.1:${(seeder as unknown as { torrentPort: number }).torrentPort}`)

    for (let i = 0; i < 100 && !store.get().torrents[0]?.paused; i++) await new Promise((r) => setTimeout(r, 100))
    expect(crashes).toEqual([])
    expect(completed).toBe(1)
    expect(store.get().torrents[0]).toMatchObject({ done: true, paused: true })
  }, 20_000)
})
