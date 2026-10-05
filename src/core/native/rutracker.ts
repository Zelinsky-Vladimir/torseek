import { coerceLong, getBytes, queryStringArg } from '../cardigann/parse'
import { LoginRequiredError, type SearchQuery } from '../indexer'
import type { Release } from '../release'
import { NativeIndexer, type NativeOptions } from './base'
import { CATEGORIES } from './rutracker-categories'

// Port of Jackett's RuTracker.cs. Searching requires an account.

const LOGGED_IN = 'id="logged-in-username"'

export class RuTracker extends NativeIndexer {
  readonly meta = {
    id: 'rutracker',
    name: 'RuTracker.org',
    description: 'RuTracker.org is a RUSSIAN Semi-Private site with a thriving file-sharing community',
    language: 'ru-RU',
    type: 'semi-private',
    links: ['https://rutracker.org/', 'https://rutracker.net/'],
  }
  readonly loginMethod = 'post'
  readonly settingsFields = [
    { name: 'username', type: 'text', label: 'Username' },
    { name: 'password', type: 'password', label: 'Password' },
    { name: 'usemagnet', type: 'checkbox', label: 'Download magnet links instead of .torrent files', default: false },
    { name: 'uploader', type: 'text', label: 'Only releases by this uploader' },
  ]

  constructor(opts: NativeOptions) {
    super(opts)
    this.encoding = 'windows-1251'
    this.addCategories(CATEGORIES)
  }

  get loginPageUrl() {
    return this.url('forum/login.php')
  }

  async search(query: SearchQuery, signal?: AbortSignal): Promise<Release[]> {
    // Non-alphanumerics become the site's % wildcard
    const nm = query.q.trim() ? query.q.replace(/[^a-zA-Zа-яА-ЯёЁ0-9]+/g, '%').replace(/-/g, ' ') : ''
    const params: Record<string, string> = { nm }
    if (this.setting('uploader')) params.pn = this.setting('uploader')
    const cats = query.categories?.length ? this.categories.toTrackerIds(query.categories) : []

    const urls: string[] = []
    if (cats.length) for (let i = 0; i < cats.length; i += 200) urls.push(this.searchUrl({ ...params, f: cats.slice(i, i + 200).join(',') }))
    else urls.push(this.searchUrl(params))

    const releases: Release[] = []
    for (const url of urls) {
      let res = await this.fetch({ url, signal })
      if (!res.text.includes(LOGGED_IN)) {
        await this.login(signal)
        res = await this.fetch({ url, signal })
        if (!res.text.includes(LOGGED_IN)) throw new LoginRequiredError('Still not logged in after signing in')
      }
      releases.push(...this.parse(res.text))
    }
    return releases.sort((a, b) => (b.publishDate ?? '').localeCompare(a.publishDate ?? ''))
  }

  private searchUrl(params: Record<string, string>) {
    return this.url('forum/tracker.php') + '?' + this.form(params)
  }

  private parse(html: string): Release[] {
    const $ = this.load(html)
    const out: Release[] = []
    const useMagnet = this.flag('usemagnet')
    $('table#tor-tbl > tbody > tr').each((_, el) => {
      try {
        const row = $(el)
        const dl = row.find('td.tor-size > a.tr-dl').first()
        if (!dl.length) return // awaiting moderation
        const titleLink = row.find('td.t-title-col > div.t-title > a.tLink').first()
        const details = this.url('forum/' + titleLink.attr('href'))
        const forum = row.find('td.f-name-col > div.f-name > a').attr('href') ?? ''
        const seedCell = row.find('td:nth-child(7)')
        const seeders = seedCell.text().includes('дн') ? 0 : coerceLong(seedCell.find('b').text().trim())
        const ts = Number(row.find('td:nth-child(10)').attr('data-ts_text'))
        out.push(
          this.release({
            title: titleLink.text().trim(),
            details,
            link: useMagnet ? details : this.url('forum/' + dl.attr('href')),
            size: getBytes(row.find('td.tor-size').attr('data-ts_text') ?? ''),
            seeders,
            leechers: coerceLong(row.find('td:nth-child(8)').text()),
            grabs: coerceLong(row.find('td:nth-child(9)').text()),
            publishDate: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : undefined,
            categories: this.categories.fromTrackerId(queryStringArg(forum, 'f')),
            description: `Uploader: ${row.find('td.u-name-col').text().trim()}`,
          }),
        )
      } catch (e) {
        this.log('debug', `rutracker: bad row: ${(e as Error).message}`)
      }
    })
    return out
  }

  async login(signal?: AbortSignal) {
    this.requireCredentials()
    const res = await this.fetch({
      url: this.url('forum/login.php'),
      method: 'POST',
      body: this.form({ login_username: this.setting('username'), login_password: this.setting('password'), login: 'Login' }),
      referer: this.url('forum/login.php'),
      signal,
    })
    if (res.text.includes(LOGGED_IN)) return
    const $ = this.load(res.text)
    if ($('img[src*="/captcha/"]').length) throw new LoginRequiredError('RuTracker asks for a captcha. Sign in through the browser')
    const message = $('h4.warnColor1.tCenter.mrg_16, div.msg-main').first().text().trim()
    if (await this.testLogin(signal)) return
    throw new LoginRequiredError(message || 'RuTracker authentication failed')
  }

  async testLogin(signal?: AbortSignal) {
    const res = await this.fetch({ url: this.url('forum/index.php'), signal })
    return res.text.includes(LOGGED_IN)
  }

  async resolveDownload(release: Pick<Release, 'link' | 'magnet' | 'title'>, signal?: AbortSignal) {
    if (release.link?.includes('viewtopic.php?t=')) {
      const res = await this.fetch({ url: release.link, signal })
      const magnet = this.load(res.text)('a.magnet-link[href^="magnet:?"]').first().attr('href')
      if (!magnet) throw new LoginRequiredError('No magnet link on the topic page (signed out?)')
      return { kind: 'magnet' as const, uri: magnet }
    }
    return super.resolveDownload(release, signal)
  }
}
