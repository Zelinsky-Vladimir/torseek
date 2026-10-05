import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SearchQuery } from '../src/core/indexer'
import type { Release } from '../src/core/release'
import { TorznabServer } from '../src/core/torznab'

const releases: Release[] = [
  { indexerId: 'a', indexerName: 'A', title: 'Show S01E02 1080p', guid: 'g1', link: 'https://a.test/t/1.torrent', categories: [5040], seeders: 50, leechers: 5, size: 1e9, infoHash: 'ab'.repeat(20), publishDate: '2026-10-01T00:00:00.000Z' },
  { indexerId: 'b', indexerName: 'B', title: 'Show S01E02 720p', guid: 'g2', magnet: 'magnet:?xt=urn:btih:' + 'cd'.repeat(20), categories: [5030], seeders: 10 },
  { indexerId: 'b', indexerName: 'B', title: 'Some Movie 2026', guid: 'g3', magnet: 'magnet:?xt=urn:btih:' + 'ef'.repeat(20), categories: [2040], seeders: 99 },
]

let server: TorznabServer
let base: string
const queries: { q: SearchQuery; ids: string[] }[] = []

beforeAll(async () => {
  server = new TorznabServer(
    {
      indexers: () => [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
      search: async (q, ids) => {
        queries.push({ q, ids })
        return releases.filter((r) => ids.includes(r.indexerId))
      },
      resolve: async (r) => (r.magnet ? { kind: 'magnet', uri: r.magnet } : { kind: 'torrent', data: new TextEncoder().encode('d8:announce0:e') }),
    },
    { port: 0, apiKey: 'secret' },
  )
  const port = await server.start()
  base = `http://127.0.0.1:${port}/api/v2.0/indexers`
})
afterAll(() => server.stop())

describe('Torznab API', () => {
  it('rejects a wrong API key', async () => {
    const res = await fetch(`${base}/all/results/torznab/api?t=caps&apikey=nope`)
    expect(res.status).toBe(401)
    expect(await res.text()).toContain('code="100"')
  })

  it('serves caps', async () => {
    const xml = await (await fetch(`${base}/all/results/torznab/api?t=caps&apikey=secret`)).text()
    expect(xml).toContain('<tv-search available="yes" supportedParams="q,season,ep"/>')
    expect(xml).toContain('<category id="5000" name="TV">')
    expect(xml).toContain('<subcat id="5040" name="TV/HD"/>')
  })

  it('turns tvsearch into a keyword query and filters by category', async () => {
    const xml = await (await fetch(`${base}/all/results/torznab/api?t=tvsearch&q=Show&season=1&ep=2&cat=5040&apikey=secret`)).text()
    expect(queries.at(-1)).toMatchObject({ q: { q: 'Show S01E02', categories: [5040] }, ids: ['a', 'b'] })
    expect(xml).toContain('<title>Show S01E02 1080p</title>')
    expect(xml).not.toContain('720p') // 5030 doesn't match 5040
    expect(xml).not.toContain('Some Movie')
    expect(xml).toContain('<torznab:attr name="seeders" value="50"/>')
    expect(xml).toContain('<torznab:attr name="peers" value="55"/>')
    expect(xml).toContain('<pubDate>Thu, 01 Oct 2026 00:00:00 GMT</pubDate>')
  })

  it('limits a search to one indexer', async () => {
    const xml = await (await fetch(`${base}/b/results/torznab/api?t=search&q=movie&apikey=secret`)).text()
    expect(queries.at(-1)?.ids).toEqual(['b'])
    expect(xml).toContain('Some Movie 2026')
    expect((await fetch(`${base}/zzz/results/torznab/api?t=search&q=x&apikey=secret`)).status).toBe(404)
  })

  it('downloads through /dl: magnet redirect or .torrent body', async () => {
    const xml = await (await fetch(`${base}/all/results/torznab/api?t=search&q=show&cat=5000&apikey=secret`)).text()
    const links = [...xml.matchAll(/<link>([^<]+)<\/link>/g)].map((m) => m[1].replace(/&amp;/g, '&'))
    const torrent = await fetch(links.find((l) => l.includes('/dl/a'))!)
    expect(torrent.headers.get('content-type')).toBe('application/x-bittorrent')
    expect(new TextDecoder().decode(await torrent.arrayBuffer())).toBe('d8:announce0:e')
    const magnet = await fetch(links.find((l) => l.includes('/dl/b'))!, { redirect: 'manual' })
    expect(magnet.status).toBe(302)
    expect(magnet.headers.get('location')).toMatch(/^magnet:\?xt=urn:btih:cdcd/)
  })
})
