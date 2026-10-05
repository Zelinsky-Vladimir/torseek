import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { categoryMatches, TORZNAB_CATEGORIES } from './categories'
import type { DownloadTarget, SearchQuery } from './indexer'
import type { Release } from './release'

// Torznab API so Sonarr / Radarr / Lidarr / Prowlarr can use Torseek like Jackett:
//   GET /api/v2.0/indexers/{id|all}/results/torznab/api?t=caps|search|tvsearch|movie|music|book
//   GET /dl/{indexerId}?apikey=…&r=…   -> .torrent file, or a redirect to the magnet
// Same URL layout as Jackett, so existing *arr setups only need the address and key.

export interface TorznabIndexer {
  id: string
  name: string
}

export interface TorznabBackend {
  /** Indexers reachable through the API ("all" = these) */
  indexers(): TorznabIndexer[]
  search(query: SearchQuery, indexerIds: string[], timeoutMs: number): Promise<Release[]>
  resolve(release: Pick<Release, 'indexerId' | 'link' | 'magnet' | 'title'>): Promise<DownloadTarget>
}

export interface TorznabOptions {
  port: number
  apiKey: string
  host?: string
  timeoutMs?: number
  log?: (msg: string) => void
}

const esc = (s: string | number | undefined) =>
  String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!)

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8')

export function capsXml(): string {
  const tops = Object.entries(TORZNAB_CATEGORIES).filter(([, id]) => id % 1000 === 0)
  const cats = tops
    .map(([name, id]) => {
      const subs = Object.entries(TORZNAB_CATEGORIES)
        .filter(([, sid]) => sid !== id && Math.floor(sid / 1000) * 1000 === id)
        .map(([sname, sid]) => `      <subcat id="${sid}" name="${esc(sname)}"/>`)
        .join('\n')
      return `    <category id="${id}" name="${esc(name)}">\n${subs}\n    </category>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="Torseek"/>
  <limits default="100" max="100"/>
  <searching>
    <search available="yes" supportedParams="q"/>
    <tv-search available="yes" supportedParams="q,season,ep"/>
    <movie-search available="yes" supportedParams="q"/>
    <music-search available="yes" supportedParams="q"/>
    <audio-search available="yes" supportedParams="q"/>
    <book-search available="yes" supportedParams="q"/>
  </searching>
  <categories>
${cats}
  </categories>
</caps>`
}

export function rssXml(releases: Release[], linkFor: (r: Release) => string, names: Map<string, string>): string {
  const items = releases.map((r) => {
    const link = linkFor(r)
    const peers = (r.seeders ?? 0) + (r.leechers ?? 0)
    const attrs: [string, string | number | undefined][] = [
      ...r.categories.map((c) => ['category', c] as [string, number]),
      ['seeders', r.seeders],
      ['peers', peers],
      ['infohash', r.infoHash],
      ['magneturl', r.magnet],
      ['grabs', r.grabs],
      ['files', r.files],
      ['imdbid', r.imdb ? `tt${String(r.imdb).padStart(7, '0')}` : undefined],
      ['downloadvolumefactor', r.downloadVolumeFactor ?? 1],
      ['uploadvolumefactor', r.uploadVolumeFactor ?? 1],
    ]
    return `    <item>
      <title>${esc(r.title)}</title>
      <guid>${esc(r.guid)}</guid>
      <jackettindexer id="${esc(r.indexerId)}">${esc(names.get(r.indexerId) ?? r.indexerName)}</jackettindexer>
      ${r.details ? `<comments>${esc(r.details)}</comments>` : ''}
      ${r.publishDate ? `<pubDate>${new Date(r.publishDate).toUTCString()}</pubDate>` : ''}
      <size>${r.size ?? 0}</size>
      <link>${esc(link)}</link>
      ${r.categories.map((c) => `<category>${c}</category>`).join('')}
      <enclosure url="${esc(link)}" length="${r.size ?? 0}" type="application/x-bittorrent"/>
${attrs
  .filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([n, v]) => `      <torznab:attr name="${n}" value="${esc(v)}"/>`)
  .join('\n')}
    </item>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>Torseek</title>
    <description>Torseek Torznab feed</description>
${items.join('\n')}
  </channel>
</rss>`
}

const errorXml = (code: number, description: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<error code="${code}" description="${esc(description)}"/>`

/** Torznab query params -> our query. TV searches become "Show S01E02". */
export function toSearchQuery(p: URLSearchParams): SearchQuery {
  let q = (p.get('q') ?? '').trim()
  const season = p.get('season')
  const ep = p.get('ep')
  if (p.get('t') === 'tvsearch' && season && /^\d+$/.test(season)) {
    q += ` S${season.padStart(2, '0')}`
    if (ep && /^\d+$/.test(ep)) q += `E${ep.padStart(2, '0')}`
  }
  const categories = (p.get('cat') ?? '')
    .split(',')
    .map((c) => Number.parseInt(c, 10))
    .filter((c) => Number.isFinite(c) && c > 0 && c < 100000)
  const limit = Number.parseInt(p.get('limit') ?? '', 10)
  return { q: q.trim(), categories: categories.length ? categories : undefined, limit: Number.isFinite(limit) && limit > 0 ? limit : undefined }
}

export class TorznabServer {
  private server?: Server
  port?: number

  constructor(
    private readonly backend: TorznabBackend,
    private readonly opts: TorznabOptions,
  ) {}

  async start(): Promise<number> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        this.opts.log?.(`torznab: ${(e as Error).message}`)
        if (!res.headersSent) this.send(res, 500, errorXml(900, (e as Error).message))
      })
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.opts.port, this.opts.host ?? '127.0.0.1', () => resolve())
    })
    this.port = (this.server.address() as AddressInfo).port
    return this.port
  }

  async stop() {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
    this.server = undefined
  }

  private send(res: ServerResponse, status: number, body: string | Uint8Array, type = 'application/xml; charset=utf-8', headers: Record<string, string> = {}) {
    res.writeHead(status, { 'Content-Type': type, ...headers })
    res.end(body)
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    const p = url.searchParams
    if (p.get('apikey') !== this.opts.apiKey) return this.send(res, 401, errorXml(100, 'Invalid API Key'))

    // /dl/{indexer}?r=…
    const dl = /^\/dl\/([^/]+)\/?$/.exec(url.pathname)
    if (dl) {
      const info = JSON.parse(unb64(p.get('r') ?? '')) as { link?: string; magnet?: string; title: string }
      const target = await this.backend.resolve({ indexerId: decodeURIComponent(dl[1]), ...info })
      if (target.kind === 'magnet') return this.send(res, 302, '', 'text/plain', { Location: target.uri })
      const name = info.title.replace(/[^\p{L}\p{N} ._-]+/gu, '_').slice(0, 150)
      return this.send(res, 200, target.data, 'application/x-bittorrent', { 'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}.torrent"` })
    }

    // /api/v2.0/indexers/{id}/results/torznab[/api]
    const api = /^\/api\/v2\.0\/indexers\/([^/]+)\/results\/torznab(?:\/api)?\/?$/.exec(url.pathname)
    if (!api) return this.send(res, 404, errorXml(202, 'No such function'))
    const id = decodeURIComponent(api[1])
    const all = this.backend.indexers()
    const ids = id === 'all' ? all.map((i) => i.id) : all.some((i) => i.id === id) ? [id] : []
    if (!ids.length) return this.send(res, 404, errorXml(201, `Indexer ${id} is not enabled`))

    const t = p.get('t') ?? 'search'
    if (t === 'caps') return this.send(res, 200, capsXml())
    if (!['search', 'tvsearch', 'tv-search', 'movie', 'movie-search', 'music', 'audio', 'book'].includes(t)) {
      return this.send(res, 400, errorXml(202, `Function ${t} not available`))
    }
    // ID-only searches (imdbid/tvdbid without q) can't be answered by keyword trackers
    const query = toSearchQuery(p)
    if (!query.q && ['imdbid', 'tvdbid', 'tmdbid', 'rid', 'tvmazeid'].some((k) => p.get(k))) {
      return this.send(res, 200, rssXml([], () => '', new Map()))
    }

    let releases = await this.backend.search(query, ids, this.opts.timeoutMs ?? 30_000)
    if (query.categories?.length) {
      releases = releases.filter((r) => !r.categories.length || r.categories.some((c) => query.categories!.some((w) => categoryMatches(c, w))))
    }
    releases.sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0))
    if (query.limit) releases = releases.slice(0, query.limit)

    const base = `http://${req.headers.host ?? `127.0.0.1:${this.port}`}`
    // Always through /dl (like Jackett): it serves the .torrent or redirects to the magnet
    const linkFor = (r: Release) =>
      `${base}/dl/${encodeURIComponent(r.indexerId)}?apikey=${encodeURIComponent(this.opts.apiKey)}&r=${b64(JSON.stringify({ link: r.link, magnet: r.magnet, title: r.title }))}`
    this.send(res, 200, rssXml(releases, linkFor, new Map(all.map((i) => [i.id, i.name]))))
  }
}
