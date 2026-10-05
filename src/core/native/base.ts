import * as cheerio from 'cheerio'
import { CategoryMap } from '../categories'
import { decode, urlEncode } from '../cardigann/encoding'
import type { SettingsField } from '../cardigann/types'
import { isCloudflareChallenge, type HttpClient, type HttpRequest, type HttpResponse } from '../http'
import {
  CloudflareError,
  LoginRequiredError,
  type DownloadTarget,
  type Indexer,
  type IndexerMeta,
  type IndexerSettings,
  type LogFn,
  type SearchQuery,
} from '../indexer'
import type { Release } from '../release'

// Shared plumbing for hand-written indexers (sites the YAML format can't describe well).

export interface NativeOptions {
  http: HttpClient
  log?: LogFn
}

export abstract class NativeIndexer implements Indexer {
  abstract readonly meta: IndexerMeta
  abstract readonly settingsFields: SettingsField[]
  abstract readonly loginMethod: string | undefined
  readonly canTestLogin: boolean = true
  readonly categories = new CategoryMap()
  protected encoding = 'utf-8'
  protected requestDelayMs = 0
  protected settings: IndexerSettings = {}
  protected readonly http: HttpClient
  protected readonly log: LogFn
  private nextRequestAt = 0

  constructor(opts: NativeOptions) {
    this.http = opts.http
    this.log = opts.log ?? (() => {})
  }

  get id() {
    return this.meta.id
  }
  get name() {
    return this.meta.name
  }

  get siteLink(): string {
    const link = typeof this.settings.sitelink === 'string' && this.settings.sitelink ? this.settings.sitelink : this.meta.links[0]
    return link.endsWith('/') ? link : link + '/'
  }

  get loginPageUrl(): string {
    return this.siteLink
  }

  updateSettings(settings: IndexerSettings) {
    this.settings = settings
  }

  protected setting(name: string): string {
    const v = this.settings[name] ?? this.settingsFields.find((f) => f.name === name)?.default
    return v == null ? '' : String(v)
  }

  protected flag(name: string): boolean {
    const v = this.settings[name] ?? this.settingsFields.find((f) => f.name === name)?.default
    return v === true || v === 'true'
  }

  protected addCategories(rows: [number, string, string][]) {
    for (const [id, cat, desc] of rows) this.categories.add(String(id), cat, desc)
  }

  protected url(path: string) {
    return new URL(path, this.siteLink).href
  }

  protected enc(value: string) {
    return urlEncode(value, this.encoding)
  }

  protected form(pairs: Record<string, string>) {
    return Object.entries(pairs)
      .map(([k, v]) => `${k}=${this.enc(v)}`)
      .join('&')
  }

  protected async fetch(req: HttpRequest): Promise<HttpResponse & { text: string }> {
    if (this.requestDelayMs > 0) {
      const now = Date.now()
      const wait = Math.max(0, this.nextRequestAt - now)
      this.nextRequestAt = Math.max(now, this.nextRequestAt) + this.requestDelayMs
      if (wait) await new Promise((r) => setTimeout(r, wait))
    }
    const res = await this.http.request(req)
    const text = decode(res.body, this.encoding)
    if (isCloudflareChallenge(res, text)) throw new CloudflareError(new URL(req.url).origin)
    return { ...res, text }
  }

  protected load(html: string) {
    return cheerio.load(html)
  }

  /** Result pages to fetch (setting "pages", default 1). */
  protected pageCount(): number {
    const n = Number.parseInt(this.setting('pages'), 10)
    return Number.isFinite(n) && n > 1 ? Math.min(n, 10) : 1
  }

  /**
   * Links to further result pages on a phpBB/TorrentPier-style listing: same script,
   * a higher `start=` offset. Sorted by offset, deduplicated.
   */
  protected nextPageUrls(html: string, pageUrl: string, script: string): string[] {
    const $ = this.load(html)
    const seen = new Map<number, string>()
    $(`a[href*="${script}"][href*="start="]`).each((_, el) => {
      const href = $(el).attr('href')
      if (!href) return
      const url = new URL(href.replace(/&amp;/g, '&'), pageUrl)
      const start = Number(url.searchParams.get('start'))
      if (start > 0 && !seen.has(start)) seen.set(start, url.href)
    })
    return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, u]) => u)
  }

  protected requireCredentials() {
    if (!this.setting('username') || !this.setting('password')) {
      throw new LoginRequiredError('Fill in username and password, or sign in through the browser')
    }
  }

  protected release(fields: Omit<Release, 'indexerId' | 'indexerName' | 'guid' | 'categories'> & { categories?: number[] }): Release {
    return {
      indexerId: this.id,
      indexerName: this.name,
      categories: [],
      guid: fields.details ?? fields.link ?? fields.title,
      ...fields,
    }
  }

  abstract search(query: SearchQuery, signal?: AbortSignal): Promise<Release[]>
  abstract login(signal?: AbortSignal): Promise<void>
  abstract testLogin(signal?: AbortSignal): Promise<boolean>

  async resolveDownload(release: Pick<Release, 'link' | 'magnet' | 'title'>, signal?: AbortSignal): Promise<DownloadTarget> {
    if (!release.link) {
      if (release.magnet) return { kind: 'magnet', uri: release.magnet }
      throw new Error('Release has no download link')
    }
    const res = await this.fetch({ url: release.link, referer: this.siteLink, signal })
    if (res.magnet) return { kind: 'magnet', uri: res.magnet }
    if (res.body[0] !== 0x64 /* 'd' */) {
      if (release.magnet) return { kind: 'magnet', uri: release.magnet }
      throw new LoginRequiredError('The tracker did not return a .torrent file (signed out?)')
    }
    return { kind: 'torrent', data: res.body }
  }

  async logout() {
    await this.http.clearCookies(this.siteLink)
  }

  async checkAccess(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.fetch({ url: this.siteLink, signal })
      return true
    } catch (e) {
      if (e instanceof CloudflareError) return false
      throw e
    }
  }
}
