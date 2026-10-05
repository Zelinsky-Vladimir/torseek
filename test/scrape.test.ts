import { createSocket } from 'node:dgram'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { scrapeAll } from '../src/core/scrape'
import { withLiveSeeds, type Release } from '../src/core/release'

// A minimal BEP 15 tracker: answers connect, then scrape with fixed counts per hash
function fakeTracker(counts: Record<string, [number, number]>) {
  const server = createSocket('udp4')
  const seenBatches: number[] = []
  server.on('message', (msg, rinfo) => {
    const action = msg.readUInt32BE(8)
    const tid = msg.readUInt32BE(12)
    if (action === 0) {
      const res = Buffer.alloc(16)
      res.writeUInt32BE(0, 0)
      res.writeUInt32BE(tid, 4)
      res.writeBigUInt64BE(0x1234n, 8)
      return server.send(res, rinfo.port, rinfo.address)
    }
    const n = (msg.length - 16) / 20
    seenBatches.push(n)
    const res = Buffer.alloc(8 + 12 * n)
    res.writeUInt32BE(2, 0)
    res.writeUInt32BE(tid, 4)
    for (let i = 0; i < n; i++) {
      const hash = msg.subarray(16 + 20 * i, 36 + 20 * i).toString('hex')
      const [s, l] = counts[hash] ?? [0, 0]
      res.writeUInt32BE(s, 8 + 12 * i)
      res.writeUInt32BE(1, 12 + 12 * i)
      res.writeUInt32BE(l, 16 + 12 * i)
    }
    server.send(res, rinfo.port, rinfo.address)
  })
  return new Promise<{ url: string; close: () => void; seenBatches: number[] }>((resolve) =>
    server.bind(0, '127.0.0.1', () => resolve({ url: `udp://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close(), seenBatches })),
  )
}

const hash = (i: number) => i.toString(16).padStart(40, '0')
const closers: (() => void)[] = []
afterEach(() => closers.splice(0).forEach((c) => c()))

describe('live seeds', () => {
  it('scrapes in batches and keeps the best answer per torrent', async () => {
    const a = await fakeTracker({ [hash(1)]: [8, 7], [hash(2)]: [100, 3] })
    const b = await fakeTracker({ [hash(1)]: [3, 9] })
    closers.push(a.close, b.close)
    const hashes = Array.from({ length: 150 }, (_, i) => hash(i + 1))
    const stats = await scrapeAll([...hashes, 'not-a-hash'], [a.url, b.url, 'udp://127.0.0.1:1'], 500)
    expect(stats.get(hash(1))).toEqual({ seeders: 8, leechers: 9 })
    expect(stats.get(hash(2))).toEqual({ seeders: 100, leechers: 3 })
    expect(stats.size).toBe(150)
    expect(a.seenBatches).toEqual([70, 70, 10])
  })

  it('replaces site numbers once, remembering what the site said', () => {
    const r = { indexerId: 'x', indexerName: 'X', title: 't', guid: 'g', magnet: `magnet:?xt=urn:btih:${hash(1).toUpperCase()}`, seeders: 67, leechers: 56, categories: [] } as Release
    const live = withLiveSeeds(r, { [hash(1)]: { seeders: 8, leechers: 7 } })
    expect(live).toMatchObject({ seeders: 8, leechers: 7, siteSeeders: 67, liveSeeds: true })
    expect(withLiveSeeds(live, { [hash(1)]: { seeders: 1, leechers: 1 } })).toBe(live)
  })

  it("keeps the site's count for torrents that live on the site's own tracker", () => {
    const rutracker = { indexerId: 'x', indexerName: 'X', title: 't', guid: 'g', magnet: `magnet:?xt=urn:btih:${hash(1)}&tr=http%3A%2F%2Fbt4.t-ru.org%2Fann%3Fmagnet`, seeders: 459, categories: [] } as Release
    expect(withLiveSeeds(rutracker, { [hash(1)]: { seeders: 3, leechers: 1 } }).seeders).toBe(459)
    const open = { ...rutracker, magnet: `magnet:?xt=urn:btih:${hash(1)}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce` }
    expect(withLiveSeeds(open, { [hash(1)]: { seeders: 3, leechers: 1 } }).seeders).toBe(3)
  })
})
