import type { CheerioAPI } from 'cheerio'
import { fromUnknown } from '../cardigann/dates'
import { getBytes } from '../cardigann/parse'
import type { DownloadTarget, SearchQuery } from '../indexer'
import { magnetToInfoHash, type Release } from '../release'
import { NativeIndexer, type NativeOptions } from './base'

// EXT (ext.to), a public general tracker; not in Jackett or Prowlarr. Results are a table
// whose rows carry a magnet button (a.torrent-dwn), a details link, size, seeders /
// leechers (.text-success / .text-danger) and age. The parser looks for those pieces
// in each row rather than at fixed columns, so a moved column doesn't break it.
// The site sits behind a Cloudflare check: the first search reports "blocked" and the
// usual "open site" window lets the user pass it once.

const CATEGORY_WORDS: [RegExp, number][] = [
  [/\banime\b/i, 5070],
  [/\b(tv|series|shows?)\b/i, 5000],
  [/\bmovies?\b|\bfilms?\b/i, 2000],
  [/\bmusic\b|\baudio\b/i, 3000],
  [/\bgames?\b/i, 1000],
  [/\b(apps?|software|applications?)\b/i, 4000],
  [/\b(books?|e-?books?)\b/i, 7000],
  [/\b(xxx|adult|porn)\b/i, 6000],
  [/\bother\b/i, 8000],
]

export class Ext extends NativeIndexer {
  readonly meta = {
    id: 'ext',
    name: 'EXT',
    description: 'EXT (ext.to) is a Public torrent tracker for MOVIES / TV / GENERAL',
    language: 'en-US',
    type: 'public',
    links: ['https://ext.to/'],
  }
  readonly settingsFields = []

  constructor(opts: NativeOptions) {
    super(opts)
    for (const [, cat] of CATEGORY_WORDS) this.categories.add(String(cat), String(cat))
  }

  async search(query: SearchQuery, signal?: AbortSignal): Promise<Release[]> {
    const q = query.q.trim()
    // Empty query = latest torrents, newest first (the site's own browse page)
    const url = q ? this.url(`search/?q=${encodeURIComponent(q)}`) : this.url('browse/?sort=age&order=desc')
    const res = await this.fetch({ url, headers: { Accept: 'text/html' }, signal })
    return this.parse(this.load(res.text))
  }

  parse($: CheerioAPI): Release[] {
    const out: Release[] = []
    $('tr').each((_, el) => {
      const row = $(el)
      const magnet = row.find('a[href^="magnet:"]').first().attr('href')
      // The title link: the first site link that isn't a category/browse/user link
      const link = row
        .find('a[href^="/"], a[href^="https://ext.to/"]')
        .filter((_, a) => !/\/(browse|user|search|cat)\b|\?/.test($(a).attr('href') ?? ''))
        .first()
      const href = link.attr('href')
      if (!magnet && !href) return
      const title = (link.attr('title') || link.text()).replace(/\s+/g, ' ').trim() || (href ? slugTitle(href) : '')
      if (!title) return

      const cells = row.find('td').toArray().map((td) => $(td).text().replace(/\s+/g, ' ').trim())
      const sizeText = cells.map((c) => /(\d+(?:[.,]\d+)?)\s*(?:[KMGT]i?B|bytes?)\b/i.exec(c)?.[0]).find(Boolean)
      const num = (sel: string) => {
        const v = Number.parseInt(row.find(sel).first().text().replace(/[^\d]/g, ''), 10)
        return Number.isFinite(v) ? v : undefined
      }
      const ageText = cells.find((c) => /\bago\b|^\d{4}-\d{2}-\d{2}|\b(today|yesterday)\b/i.test(c))
      let publishDate: string | undefined
      try {
        publishDate = ageText ? fromUnknown(ageText).toISOString() : undefined
      } catch {
        publishDate = undefined
      }
      const catText = row.find('a[href*="cat="], .category, [class*="cat"]').text() || ''
      const category = CATEGORY_WORDS.find(([re]) => re.test(catText))?.[1]
      const details = href ? new URL(href, this.siteLink).href : undefined

      out.push(
        this.release({
          title,
          details,
          link: magnet ? undefined : details,
          magnet,
          infoHash: magnet ? magnetToInfoHash(magnet) : undefined,
          size: sizeText ? getBytes(sizeText) : undefined,
          seeders: num('.text-success'),
          leechers: num('.text-danger'),
          publishDate,
          categories: category ? [category] : [],
        }),
      )
    })
    return out
  }

  // Rows without a magnet button: the magnet is on the details page
  async resolveDownload(release: Pick<Release, 'link' | 'magnet' | 'title'>, signal?: AbortSignal): Promise<DownloadTarget> {
    if (release.magnet) return { kind: 'magnet', uri: release.magnet }
    if (!release.link) throw new Error('Release has no download link')
    const res = await this.fetch({ url: release.link, referer: this.siteLink, signal })
    const magnet = this.load(res.text)('a[href^="magnet:"]').first().attr('href')
    if (!magnet) throw new Error('Download did not return a torrent file')
    return { kind: 'magnet', uri: magnet }
  }
}

/** "/dune-part-two-2024-1080p-web-12345/" -> "dune part two 2024 1080p web" */
function slugTitle(href: string): string {
  const slug = decodeURIComponent(href.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() ?? '')
  return slug.replace(/-\d+$/, '').replace(/[-_.]+/g, ' ').trim()
}
