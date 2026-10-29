import * as cheerio from 'cheerio'
import { describe, expect, it } from 'vitest'
import { Ext } from '../src/core/native/ext'
import { groupReleases, type Release } from '../src/core/release'

// Markup as the site serves it (table rows with a magnet button), from a scraper that
// parsed it; our parser looks for the pieces per row, not at fixed columns.
const HTML = `
<table><thead><tr><th>Name</th><th>Size</th><th>Age</th><th>Seeds</th><th>Leechers</th></tr></thead>
<tbody>
<tr>
  <td><a href="/dune-part-two-2024-1080p-webrip-x265-12345/" title="Dune Part Two 2024 1080p WEBRip x265">Dune Part Two 2024 1080p WEBRip x265</a>
      <a class="dwn-btn torrent-dwn" href="magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&dn=dune">magnet</a>
      <a href="/browse/?cat=1">Movies</a></td>
  <td><span>2.4 GB</span></td><td>3 days ago</td>
  <td><span class="text-success">1,204</span></td><td><span class="text-danger">87</span></td>
</tr>
<tr>
  <td><a href="/the-office-s01-complete-720p-777/">The Office S01 COMPLETE 720p</a> <a href="/browse/?cat=2">TV</a></td>
  <td>3.1 GB</td><td>2024-05-01</td><td><span class="text-success">55</span></td><td><span class="text-danger">3</span></td>
</tr>
<tr><td colspan="5">Advertisement</td></tr>
</tbody></table>`

describe('EXT', () => {
  const ext = new Ext({ http: { request: async () => { throw new Error('offline') } } as never })

  it('parses result rows', () => {
    const rows = ext.parse(cheerio.load(HTML))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      title: 'Dune Part Two 2024 1080p WEBRip x265',
      details: 'https://ext.to/dune-part-two-2024-1080p-webrip-x265-12345/',
      infoHash: 'abcdef0123456789abcdef0123456789abcdef01',
      seeders: 1204,
      leechers: 87,
      categories: [2000],
    })
    expect(rows[0].size).toBeCloseTo(2.4 * 1024 ** 3, -6)
    expect(rows[0].publishDate).toBeTruthy()
    // no magnet in the row: downloaded through the details page
    expect(rows[1]).toMatchObject({ title: 'The Office S01 COMPLETE 720p', link: 'https://ext.to/the-office-s01-complete-720p-777/', categories: [5000], seeders: 55 })
  })
})

describe('tracker priority', () => {
  it('makes the priority tracker’s copy the one shown and downloaded', () => {
    const copy = (indexerId: string, seeders: number): Release => ({ indexerId, indexerName: indexerId, title: 'X', guid: indexerId, infoHash: 'a'.repeat(40), seeders, categories: [] })
    const rank = (r: Release) => (r.indexerId === 'thepiratebay' ? 0 : 1)
    const [g] = groupReleases([copy('knaben', 500), copy('thepiratebay', 20), copy('yts', 900)], undefined, rank).values()
    expect(g.primary.indexerId).toBe('thepiratebay')
    // without priorities: best seeded
    const [h] = groupReleases([copy('knaben', 500), copy('thepiratebay', 20), copy('yts', 900)]).values()
    expect(h.primary.indexerId).toBe('yts')
  })
})
