import { fromUnknown } from '../cardigann/dates'
import { coerceLong, getBytes, queryStringArg } from '../cardigann/parse'
import { LoginRequiredError, type SearchQuery } from '../indexer'
import type { Release } from '../release'
import { NativeIndexer, type NativeOptions } from './base'
import { CATEGORIES } from './toloka-categories'

// Port of Jackett's Toloka.cs. Searching requires an account.

const LOGGED_IN = 'logout=true'

export class Toloka extends NativeIndexer {
  readonly meta = {
    id: 'toloka',
    name: 'Toloka.to',
    description: 'Toloka is a UKRAINIAN Semi-Private site with a thriving file-sharing community',
    language: 'uk-UA',
    type: 'semi-private',
    links: ['https://toloka.to/'],
  }
  readonly loginMethod = 'post'
  readonly settingsFields = [
    { name: 'username', type: 'text', label: 'Username' },
    { name: 'password', type: 'password', label: 'Password' },
    { name: 'freeleech', type: 'checkbox', label: 'Search freeleech only', default: false },
    { name: 'pages', type: 'select', label: 'Result pages per search', default: '2', options: { '1': '1', '2': '2', '3': '3', '5': '5' } },
  ]

  constructor(opts: NativeOptions) {
    super(opts)
    this.addCategories(CATEGORIES)
  }

  get loginPageUrl() {
    return this.url('login.php')
  }

  async search(query: SearchQuery, signal?: AbortSignal): Promise<Release[]> {
    const pairs: [string, string][] = [
      ['o', '1'],
      ['s', '2'],
    ]
    if (this.flag('freeleech')) pairs.push(['sds', '1'])
    pairs.push(['nm', query.q.trim().replace(/-/g, ' ')])
    for (const cat of query.categories?.length ? this.categories.toTrackerIds(query.categories) : []) pairs.push(['f[]', cat])
    const url = this.url('tracker.php') + '?' + pairs.map(([k, v]) => `${k}=${this.enc(v)}`).join('&')

    let res = await this.fetch({ url, signal })
    if (!res.text.includes(LOGGED_IN)) {
      await this.login(signal)
      res = await this.fetch({ url, signal })
      if (!res.text.includes(LOGGED_IN)) throw new LoginRequiredError('Still not logged in after signing in')
    }
    const releases = this.parse(res.text)
    if (query.q.trim()) {
      for (const next of this.nextPageUrls(res.text, url, 'tracker.php').slice(0, this.pageCount() - 1)) {
        releases.push(...this.parse((await this.fetch({ url: next, signal })).text))
      }
    }
    return releases
  }

  private parse(html: string): Release[] {
    const $ = this.load(html)
    const out: Release[] = []
    $('table.forumline > tbody > tr[class*="prow"]').each((_, el) => {
      try {
        const row = $(el)
        const dl = row.find('td:nth-child(6) > a').first()
        if (!dl.length) return // awaiting moderation
        const titleLink = row.find('td:nth-child(3) > a').first()
        const forum = row.find('td:nth-child(2) > a').attr('href') ?? ''
        const seeds = row.find('td:nth-child(10) > b').text().trim()
        let factor = 1
        if (row.find('img[src="images/gold.gif"], img[src="images/authors.gif"]').length) factor = 0
        else if (row.find('img[src="images/silver.gif"]').length) factor = 0.5
        else if (row.find('img[src="images/bronze.gif"]').length) factor = 0.75
        let publishDate: string | undefined
        try {
          publishDate = fromUnknown(row.find('td:nth-child(13)').text()).toISOString()
        } catch {
          /* leave undated */
        }
        out.push(
          this.release({
            title: titleLink.text().trim(),
            details: this.url(titleLink.attr('href') ?? ''),
            link: this.url(dl.attr('href') ?? ''),
            size: getBytes(row.find('td:nth-child(7)').text()),
            seeders: seeds ? coerceLong(seeds) : 0,
            leechers: coerceLong(row.find('td:nth-child(11) > b').text()),
            publishDate,
            categories: this.categories.fromTrackerId(queryStringArg(forum, 'f')),
            downloadVolumeFactor: factor,
            uploadVolumeFactor: 1,
          }),
        )
      } catch (e) {
        this.log('debug', `toloka: bad row: ${(e as Error).message}`)
      }
    })
    return out
  }

  async login(signal?: AbortSignal) {
    this.requireCredentials()
    const res = await this.fetch({
      url: this.url('login.php'),
      method: 'POST',
      body: this.form({ username: this.setting('username'), password: this.setting('password'), autologin: 'on', ssl: 'on', redirect: '', login: 'Вхід' }),
      referer: this.url('login.php'),
      signal,
    })
    if (res.text.includes(LOGGED_IN)) return
    if (await this.testLogin(signal)) return
    const message = this.load(res.text)('table.forumline table span.gen').first().contents().first().text().trim()
    throw new LoginRequiredError(message || 'Toloka authentication failed')
  }

  async testLogin(signal?: AbortSignal) {
    const res = await this.fetch({ url: this.url('index.php'), signal })
    return res.text.includes(LOGGED_IN)
  }
}
