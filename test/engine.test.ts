import { describe, expect, it } from 'vitest'
import { CardigannIndexer } from '../src/core/cardigann/indexer'
import { parseDefinition } from '../src/core/cardigann/loader'
import { applyTemplate } from '../src/core/cardigann/template'
import { dotnetRegex, dotnetReplace } from '../src/core/cardigann/dotnet-regex'
import { fromTimeAgo, fromUnknown, parseDateLayout } from '../src/core/cardigann/dates'
import { getBytes, coerceLong } from '../src/core/cardigann/parse'
import { urlEncode } from '../src/core/cardigann/encoding'
import { HttpClient } from '../src/core/http'
import { groupReleases, normalizeInfoHash, parseQuality } from '../src/core/release'

describe('template', () => {
  const vars = { '.Keywords': 'dune part two', '.Config.sort': 'seeders', '.True': 'True', '.False': null, '.Empty': '' }

  it('substitutes variables with a modifier', () => {
    expect(applyTemplate('search/{{ .Keywords }}/', vars, encodeURIComponent)).toBe('search/dune%20part%20two/')
  })
  it('handles if/else and logic functions', () => {
    expect(applyTemplate('{{ if .Keywords }}q{{ else }}top{{ end }}', vars)).toBe('q')
    expect(applyTemplate('{{ if .Empty }}q{{ else }}top{{ end }}', vars)).toBe('top')
    expect(applyTemplate('{{ if and (.Keywords) (.Empty) }}y{{ else }}n{{ end }}', vars)).toBe('n')
    expect(applyTemplate('{{ if or (.Empty) (.Keywords) }}y{{ else }}n{{ end }}', vars)).toBe('y')
    expect(applyTemplate('{{ if eq .Config.sort "seeders" }}s{{ else }}t{{ end }}', vars)).toBe('s')
    expect(applyTemplate('{{ if ne .Config.sort "seeders" }}s{{ else }}t{{ end }}', vars)).toBe('t')
  })
  it('handles range, join and re_replace', () => {
    const v = { '.Categories': ['1', '2'], '.Keywords': 'a b' }
    expect(applyTemplate('{{ range .Categories }}c={{.}}&{{end}}', v)).toBe('c=1&c=2&')
    expect(applyTemplate('{{ join .Categories "," }}', v)).toBe('1,2')
    expect(applyTemplate('{{ re_replace .Keywords "\\s+" "%" }}', v)).toBe('a%b')
  })
})

describe('.NET regex compatibility', () => {
  it('supports inline flags and Unicode word classes', () => {
    expect(dotnetRegex('(?i)dune').test('DUNE')).toBe(true)
    expect(dotnetReplace('Дюна 2024', '\\w+', 'x')).toBe('x x')
    expect(dotnetReplace('Дюна', '\\bДюна\\b', 'Dune')).toBe('Dune')
  })
  it('translates replacement syntax', () => {
    expect(dotnetReplace('S01E02', 'S(?<s>\\d+)E(\\d+)', '${s}x$2')).toBe('01x02')
    expect(dotnetReplace('abc', 'b', '[$0]')).toBe('a[b]c')
  })
  it('keeps Unicode semantics for \W inside character classes', () => {
    // TPB keyword filter: CJK and non-word runs become "." but Cyrillic words survive
    expect(dotnetReplace('дюна 2', '([\\p{IsCJKUnifiedIdeographs}\\W]+)', '.')).toBe('дюна.2')
    expect(dotnetReplace('a-b дю', '[^\\W]+', 'x')).toBe('x-x x')
  })
  it('handles Unicode blocks and lone braces', () => {
    expect(dotnetReplace('Матрица Matrix', '[\\p{IsCyrillic}]+\\s*', '')).toBe('Matrix')
    expect(dotnetReplace('{x}', '{x}', 'y')).toBe('y')
  })
})

describe('dates', () => {
  const now = new Date(2026, 9, 5, 12, 0, 0)
  it('parses .NET formats', () => {
    expect(parseDateLayout('2026-10-01 13:45 +00:00', 'yyyy-MM-dd HH:mm zzz', now).toISOString()).toBe('2026-10-01T13:45:00.000Z')
    expect(parseDateLayout('05.10.2026', 'dd.MM.yyyy', now).getDate()).toBe(5)
    expect(parseDateLayout('Oct 3, 2026, 4 pm +00:00', 'MMM d, yyyy, h tt zzz', now).toISOString()).toBe('2026-10-03T16:00:00.000Z')
  })
  it('parses Go layouts', () => {
    expect(parseDateLayout('2026-10-01', '2006-01-02', now).getMonth()).toBe(9)
  })
  it('parses relative and fuzzy dates', () => {
    expect(fromTimeAgo('2 hours ago', now).getHours()).toBe(10)
    expect(fromUnknown('Yesterday 14:22', now).getDate()).toBe(4)
    expect(fromUnknown('1759600000', now).getUTCFullYear()).toBe(2025)
    expect(fromUnknown('Sep. 14th 2026', now).getMonth()).toBe(8)
  })
})

describe('parsing helpers', () => {
  it('parses sizes like Jackett', () => {
    expect(getBytes(' 3.5  gb ')).toBe(3758096384)
    expect(getBytes('1.018,29 MB')).toBe(1067754455)
    expect(getBytes('700 МБ')).toBe(734003200)
  })
  it('coerces counts', () => {
    expect(coerceLong('1,234')).toBe(1234)
    expect(coerceLong('-')).toBe(0)
  })
  it('url-encodes in the site charset', () => {
    expect(urlEncode('матрица', 'windows-1251')).toBe('%EC%E0%F2%F0%E8%F6%E0')
    expect(urlEncode('a b', 'utf-8')).toBe('a+b')
  })
})

describe('releases', () => {
  it('normalizes base32 info hashes', () => {
    expect(normalizeInfoHash('4BSZW75HXQ5VPZKDQ2MAGPY5LSDQSDRH')).toMatch(/^[0-9a-f]{40}$/)
  })
  it('groups the same torrent from different trackers', () => {
    const base = { title: 'Dune', categories: [], guid: 'x' }
    const groups = groupReleases([
      { ...base, indexerId: 'a', indexerName: 'A', infoHash: 'abc', seeders: 5 },
      { ...base, indexerId: 'b', indexerName: 'B', infoHash: 'ABC', seeders: 50 },
    ])
    const [g] = groups.values()
    expect(groups.size).toBe(1)
    expect(g.sources).toHaveLength(2)
    expect(g.primary.indexerId).toBe('b')
  })
  it('reads quality from titles', () => {
    expect(parseQuality('Dune.Part.Two.2024.2160p.WEB-DL.DV.HDR.H.265')).toEqual({ resolution: '2160p', source: 'WEB-DL', codec: 'x265', hdr: 'DV' })
  })
})

describe('CardigannIndexer end-to-end (mocked site)', () => {
  const definition = parseDefinition(`
id: testsite
name: Test Site
type: public
links: [https://example.test/]
caps:
  categorymappings:
    - {id: 1, cat: Movies/HD, desc: "HD Movies"}
    - {id: 2, cat: TV, desc: "TV"}
  modes: {search: [q]}
settings: []
search:
  paths:
    - path: "search/{{ .Keywords }}/"
  rows:
    selector: table.results tr:has(a.title)
  fields:
    title:
      selector: a.title
    details:
      selector: a.title
      attribute: href
    category:
      selector: td.cat
    download:
      selector: a[href^="magnet:"]
      attribute: href
    size:
      selector: td.size
    seeders:
      selector: td.seeds
    leechers:
      selector: td.peers
    date:
      selector: td.date
      filters:
        - name: dateparse
          args: "yyyy-MM-dd"
`)
  const html = `<table class="results">
    <tr><th>header</th></tr>
    <tr><td class="cat">1</td><td><a class="title" href="/t/1">Dune Part Two 2024 1080p</a></td>
        <td><a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567">m</a></td>
        <td class="size">9.5 GB</td><td class="seeds">1,204</td><td class="peers">33</td><td class="date">2026-09-30</td></tr>
  </table>`

  it('searches and parses rows', async () => {
    const requested: string[] = []
    const http = new HttpClient({
      fetch: async (url) => {
        requested.push(url)
        return new Response(html, { status: 200 })
      },
    })
    const ix = new CardigannIndexer(definition, { http })
    const [r] = await ix.search({ q: 'dune part two' })
    expect(requested[0]).toBe('https://example.test/search/dune%20part%20two/')
    expect(r).toMatchObject({
      title: 'Dune Part Two 2024 1080p',
      details: 'https://example.test/t/1',
      categories: [2040],
      size: Math.floor(9.5 * 1024 ** 3),
      seeders: 1204,
      leechers: 33,
      infoHash: '0123456789abcdef0123456789abcdef01234567',
    })
    expect(r.publishDate?.startsWith('2026-09-30') || r.publishDate?.startsWith('2026-09-29')).toBe(true)
    await expect(ix.resolveDownload(r)).resolves.toEqual({ kind: 'magnet', uri: r.magnet })
  })
})
