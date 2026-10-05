import { decodeHTML } from 'entities'
import { getBytes } from '../cardigann/parse'
import type { SearchQuery } from '../indexer'
import { infoHashToMagnet, type Release } from '../release'
import { NativeIndexer, type NativeOptions } from './base'
import { CATEGORIES as KNABEN_CATEGORIES } from './knaben-categories'

// Public trackers that Jackett implements in C# (JSON APIs or unusual markup).
// Ported from Knaben.cs, TorrentsCSV.cs, SubsPlease.cs, Anilibria.cs, AudioBookBay.cs.

abstract class PublicIndexer extends NativeIndexer {
  readonly loginMethod = undefined
  readonly canTestLogin = false
  async login() {}
  async testLogin() {
    return true
  }
  protected json<T>(text: string): T {
    return JSON.parse(text) as T
  }
}

// --- Knaben: meta-search over many public trackers, JSON API ---------------------------

interface KnabenHit {
  title: string
  categoryId?: number[]
  hash?: string
  details?: string
  link?: string
  magnetUrl?: string
  bytes?: number
  seeders?: number
  peers?: number
  date?: string
  trackerId?: string
  tracker?: string
}

export class Knaben extends PublicIndexer {
  readonly meta = {
    id: 'knaben',
    name: 'Knaben',
    description: 'Knaben is a Public torrent meta-search engine',
    language: 'en-US',
    type: 'public',
    links: ['https://knaben.org/'],
  }
  readonly settingsFields = []

  constructor(opts: NativeOptions) {
    super(opts)
    this.addCategories(KNABEN_CATEGORIES)
  }

  async search(query: SearchQuery, signal?: AbortSignal): Promise<Release[]> {
    const body: Record<string, unknown> = { order_by: 'date', order_direction: 'desc', from: 0, size: 100, hide_unsafe: true }
    if (query.q.trim()) Object.assign(body, { search_type: '100%', search_field: 'title', query: query.q.trim(), order_by: 'seeders' })
    const cats = query.categories?.length ? this.categories.toTrackerIds(query.categories).map(Number) : []
    if (cats.length) body.categories = [...new Set(cats)]
    const res = await this.fetch({
      url: 'https://api.knaben.org/v1',
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      signal,
    })
    const hits = this.json<{ hits?: KnabenHit[] }>(res.text).hits ?? []
    const out: Release[] = []
    for (const h of hits) {
      if (!h.seeders) continue
      const lime = h.trackerId?.includes('limetorrents')
      if (lime && !h.magnetUrl) continue
      // Some dates come without a zone; Jackett assumes CET
      const date = h.date && !/[+-]\d{2}:?\d{2}$|Z$/.test(h.date) ? `${h.date}+01:00` : h.date
      out.push(
        this.release({
          title: h.title,
          details: h.details,
          link: lime ? undefined : h.link || undefined,
          magnet: h.magnetUrl || undefined,
          infoHash: h.hash,
          size: h.bytes,
          seeders: h.seeders,
          leechers: h.peers,
          publishDate: date ? new Date(date).toISOString() : undefined,
          categories: [...new Set((h.categoryId ?? []).flatMap((c) => this.categories.fromTrackerId(String(c))))],
          description: h.tracker,
        }),
      )
    }
    return out
  }
}

// --- Torrents-CSV: open database of DHT-crawled torrents --------------------------------

interface CsvTorrent {
  infohash: string
  name: string
  size_bytes?: number
  created_unix?: number
  seeders?: number
  leechers?: number
  completed?: number
}

export class TorrentsCsv extends PublicIndexer {
  readonly meta = {
    id: 'torrentscsv',
    name: 'Torrents.csv',
    description: 'Torrents.csv is a self-hostable open source torrent search engine and database',
    language: 'en-US',
    type: 'public',
    links: ['https://torrents-csv.com/'],
  }
  readonly settingsFields = []

  constructor(opts: NativeOptions) {
    super(opts)
    this.categories.add('8000', 'Other')
  }

  async search(query: SearchQuery, signal?: AbortSignal): Promise<Release[]> {
    const q = query.q.trim()
    if (q.length < 3) return [] // the API needs at least 3 characters
    const res = await this.fetch({ url: `${this.siteLink}service/search?size=100&q=${encodeURIComponent(q)}`, headers: { Accept: 'application/json' }, signal })
    const torrents = this.json<{ torrents?: CsvTorrent[] }>(res.text).torrents ?? []
    return torrents.map((t) =>
      this.release({
        title: t.name,
        details: `${this.siteLink}search?q=${encodeURIComponent(t.name)}`,
        infoHash: t.infohash,
        magnet: infoHashToMagnet(t.infohash, t.name),
        size: t.size_bytes,
        seeders: t.seeders ?? 0,
        leechers: t.leechers ?? 0,
        grabs: t.completed,
        publishDate: t.created_unix ? new Date(t.created_unix * 1000).toISOString() : undefined,
        categories: [8000],
      }),
    )
  }
}

// --- SubsPlease: anime fansub releases ---------------------------------------------------

interface SubsPleaseItem {
  release_date?: string
  show: string
  episode: string
  downloads: { res: string; magnet: string }[]
  image_url?: string
  page?: string
}

export class SubsPlease extends PublicIndexer {
  readonly meta = {
    id: 'subsplease',
    name: 'SubsPlease',
    description: 'SubsPlease is a Public tracker for ANIME (English subs)',
    language: 'en-US',
    type: 'public',
    links: ['https://subsplease.org/'],
  }
  readonly settingsFields = []

  constructor(opts: NativeOptions) {
    super(opts)
    this.categories.add('5070', 'TV/Anime')
  }

  async search(query: SearchQuery, signal?: AbortSignal): Promise<Release[]> {
    // The API doesn't understand "[SubsPlease]" or resolutions in the query
    const term = query.q.replace(/\[?SubsPlease\]?\s*/gi, '').replace(/\b\d{3,4}p\b/gi, '').trim()
    const params = term ? `f=search&tz=UTC&s=${encodeURIComponent(term)}` : 'f=latest&tz=UTC'
    const res = await this.fetch({ url: `${this.siteLink}api/?${params}`, headers: { Accept: 'application/json' }, signal })
    const text = res.text.trim()
    if (!text || text === '[]') return []
    const items = Object.values(this.json<Record<string, SubsPleaseItem>>(text))
    const out: Release[] = []
    for (const r of items) {
      for (const d of r.downloads ?? []) {
        const size = /[?&]xl=(\d+)/.exec(d.magnet)?.[1]
        out.push(
          this.release({
            title: `[SubsPlease] ${decodeHTML(r.show)} - ${r.episode} (${d.res}p)`,
            details: r.page ? `${this.siteLink}shows/${r.page}/` : undefined,
            magnet: d.magnet,
            size: size ? Number(size) : undefined,
            seeders: 1,
            leechers: 1,
            files: 1,
            poster: r.image_url ? new URL(r.image_url, this.siteLink).href : undefined,
            publishDate: r.release_date ? new Date(r.release_date).toISOString() : undefined,
            categories: r.episode.toLowerCase() === 'movie' ? [5070, 2020] : [5070],
            downloadVolumeFactor: 0,
          }),
        )
      }
    }
    return out
  }
}

// --- Anilibria: Russian anime dubbing group, JSON API --------------------------------------

interface AnilibriaTorrent {
  hash: string
  label?: string
  size?: number
  seeders?: number
  leechers?: number
  completed_times?: number
  updated_at?: string
  release: { id: number; alias: string; year?: number; type?: { value?: string }; name: { main: string; english?: string }; poster?: { src?: string } }
}

export class Anilibria extends PublicIndexer {
  readonly meta = {
    id: 'anilibria',
    name: 'Anilibria',
    description: 'Anilibria is a RUSSIAN anime voiceover group and tracker',
    language: 'ru-RU',
    type: 'public',
    links: ['https://aniliberty.top/', 'https://anilibria.top/'],
  }
  readonly settingsFields = [{ name: 'englishonly', type: 'checkbox', label: 'Use English titles only', default: false }]

  constructor(opts: NativeOptions) {
    super(opts)
    this.categories.add('5070', 'TV/Anime')
    this.categories.add('2000', 'Movies')
  }

  private get api() {
    return `${this.siteLink}api/v1/`
  }

  async search(query: SearchQuery, signal?: AbortSignal): Promise<Release[]> {
    const q = query.q.trim()
    let torrents: AnilibriaTorrent[] = []
    if (!q) {
      const res = await this.fetch({ url: `${this.api}anime/torrents?limit=25`, signal })
      const data = this.json<{ data?: AnilibriaTorrent[] } | AnilibriaTorrent[]>(res.text)
      torrents = Array.isArray(data) ? data : (data.data ?? [])
    } else {
      const res = await this.fetch({ url: `${this.api}app/search/releases?query=${encodeURIComponent(q)}`, signal })
      const ids = [...new Set(this.json<{ id?: number }[]>(res.text).map((r) => r.id).filter((id): id is number => !!id))].slice(0, 10)
      const lists = await Promise.all(
        ids.map((id) =>
          this.fetch({ url: `${this.api}anime/torrents/release/${id}`, signal })
            .then((r) => this.json<AnilibriaTorrent[] | AnilibriaTorrent>(r.text))
            .then((d) => (Array.isArray(d) ? d : [d]))
            .catch(() => [] as AnilibriaTorrent[]),
        ),
      )
      torrents = lists.flat()
    }
    const english = this.flag('englishonly')
    return torrents.map((t) => {
      const name = english && t.release.name.english ? t.release.name.english : t.release.name.main
      const movie = t.release.type?.value?.toUpperCase() === 'MOVIE'
      return this.release({
        title: `${name}${t.label ? ` / ${t.label}` : ''}`,
        details: `${this.siteLink}anime/releases/release/${t.release.alias}`,
        link: `${this.api}anime/torrents/${t.hash}/file`,
        infoHash: t.hash,
        magnet: infoHashToMagnet(t.hash, name),
        size: t.size,
        seeders: t.seeders,
        leechers: t.leechers,
        grabs: t.completed_times,
        publishDate: t.updated_at ? new Date(t.updated_at).toISOString() : undefined,
        poster: t.release.poster?.src ? new URL(t.release.poster.src, this.siteLink).href : undefined,
        categories: movie ? [5070, 2000] : [5070],
      })
    })
  }
}

// --- AudioBook Bay: audiobooks, info hash only on the details page ----------------------------

export class AudioBookBay extends PublicIndexer {
  readonly meta = {
    id: 'audiobookbay',
    name: 'AudioBook Bay',
    description: 'AudioBook Bay (ABB) is a Public Torrent Tracker for AUDIOBOOKS',
    language: 'en-US',
    type: 'public',
    links: ['https://audiobookbay.lu/', 'http://audiobookbay.is/', 'http://audiobookbay.se/', 'http://audiobookbay.fi/', 'http://audiobookbay.ws/'],
  }
  readonly settingsFields = []

  constructor(opts: NativeOptions) {
    super(opts)
    this.categories.add('3030', 'Audio/Audiobook')
  }

  async search(query: SearchQuery, signal?: AbortSignal): Promise<Release[]> {
    const term = query.q.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase()
    const qs = term ? `?s=${encodeURIComponent(term)}&tt=1` : ''
    const pages = [`${this.siteLink}${qs}`, `${this.siteLink}page/2/${qs}`]
    const out: Release[] = []
    for (const url of pages) {
      const res = await this.fetch({ url, headers: { Accept: 'text/html' }, signal })
      out.push(...this.parse(res.text))
    }
    return out
  }

  private parse(html: string): Release[] {
    const $ = this.load(html)
    // Some posts are base64-encoded to hide them from scrapers
    $('div.post.re-ab').each((_, el) => {
      try {
        $(el).replaceWith(`<div class="post">${Buffer.from($(el).text(), 'base64').toString('utf8')}</div>`)
      } catch {
        /* leave as is */
      }
    })
    const out: Release[] = []
    $('div.post:has(div.postTitle)').each((_, el) => {
      const row = $(el)
      const href = row.find('div.postTitle h2 a').attr('href')
      if (!href) return
      const details = new URL(href, this.siteLink).href
      let title = row.find('div.postTitle').text().trim()
      const info = row.find('div.postContent').text().trim()
      const format = /Format: (.+?) \//i.exec(info)?.[1]?.trim()
      if (format && format !== '?') title += ` [${format}]`
      const bitrate = /Bitrate: (.+?)File/i.exec(info)?.[1]?.trim()
      if (bitrate && bitrate !== '?') title += ` [${bitrate}]`
      const size = /File Size: (.+?)s?$/im.exec(info)?.[1]
      const posted = /Posted: (\d{1,2} \D{3} \d{4})/i.exec(info)?.[1]
      const cover = row.find('img[src]').attr('src')
      out.push(
        this.release({
          title: title.replace(/[\u0000-\u0008\u000A-\u001F]/g, '').replace(/\s+/g, ' ').trim(),
          details,
          link: details,
          size: size ? getBytes(size) : undefined,
          seeders: 1,
          leechers: 1,
          poster: cover ? new URL(cover, this.siteLink).href : undefined,
          publishDate: posted ? new Date(`${posted} UTC`).toISOString() : undefined,
          categories: [3030],
          downloadVolumeFactor: 0,
        }),
      )
    })
    return out
  }

  /** The details page only shows the info hash; build a magnet from it. */
  async resolveDownload(release: Pick<Release, 'link' | 'magnet' | 'title'>, signal?: AbortSignal) {
    if (!release.link) throw new Error('Release has no download link')
    const $ = this.load((await this.fetch({ url: release.link, signal })).text)
    const hash = $('td:contains("Info Hash:") ~ td').first().text().trim()
    const title = $('div.postTitle h1').first().text().trim() || release.title
    if (!/^[0-9a-f]{40}$/i.test(hash)) throw new Error('Info hash not found on the details page')
    return { kind: 'magnet' as const, uri: infoHashToMagnet(hash, title) }
  }
}
