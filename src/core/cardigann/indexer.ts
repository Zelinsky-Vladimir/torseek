import * as cheerio from 'cheerio'
import type { CheerioAPI, Cheerio } from 'cheerio'
import type { AnyNode, Element } from 'domhandler'
import { decodeHTML } from 'entities'
import { CategoryMap } from '../categories'
import { isCloudflareChallenge, type HttpClient, type HttpResponse } from '../http'
import { CloudflareError, LoginRequiredError, type DownloadTarget, type Indexer, type IndexerMeta, type IndexerSettings, type LogFn, type SearchQuery, type SettingValue } from '../indexer'
import { infoHashToMagnet, magnetToInfoHash, normalizeInfoHash, type Release } from '../release'
import { fromUnknown } from './dates'
import { decode, urlEncode } from './encoding'
import { applyFilters, selectJsonPath } from './filters'
import { coerceDouble, coerceLong, getBytes, getLongFromString, normalizeSpace } from './parse'
import { applyTemplate, type Vars } from './template'
import type { Definition, ErrorBlock, SearchPathBlock, SelectorBlock, SelectorField, SettingsField } from './types'

// Port of Jackett's CardigannIndexer: runs one YAML definition against its site.

export type { SearchQuery, SettingValue, IndexerSettings, DownloadTarget, LogFn }
export { LoginRequiredError, CloudflareError }

export interface IndexerOptions {
  http: HttpClient
  settings?: IndexerSettings
  log?: LogFn
}

// Fields that never fail a row when missing
const OPTIONAL_FIELDS = ['imdb', 'imdbid', 'tmdbid', 'rageid', 'tvdbid', 'tvmazeid', 'traktid', 'doubanid', 'poster', 'genre', 'description']
const GENRE_DELIMITERS = /[, /)(.;[\]"|:]+/
const COMMON_WORDS = ['and', 'the', 'an']

const isBlank = (v: unknown) => v == null || (typeof v === 'string' && v.trim() === '')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class CardigannIndexer implements Indexer {
  readonly id: string
  readonly name: string
  readonly categories = new CategoryMap()
  readonly settingsFields: SettingsField[]
  private readonly http: HttpClient
  private readonly log: LogFn
  private settings: IndexerSettings
  private nextRequestAt = 0

  constructor(
    readonly definition: Definition,
    opts: IndexerOptions,
  ) {
    this.id = definition.id
    this.name = definition.name
    this.http = opts.http
    this.log = opts.log ?? (() => {})
    this.settings = opts.settings ?? {}
    this.settingsFields = definition.settings ?? [
      { name: 'username', label: 'Username', type: 'text' },
      { name: 'password', label: 'Password', type: 'password' },
    ]

    const caps = definition.caps ?? {}
    for (const [trackerId, cat] of Object.entries(caps.categories ?? {})) {
      if (!this.categories.add(trackerId, cat)) this.log('warn', `${this.id}: invalid Torznab category ${cat}`)
    }
    for (const m of caps.categorymappings ?? []) {
      if (!this.categories.add(String(m.id), m.cat, m.desc, m.default)) this.log('warn', `${this.id}: invalid Torznab category ${m.cat}`)
    }
  }

  get siteLink(): string {
    const link = typeof this.settings.sitelink === 'string' && this.settings.sitelink ? this.settings.sitelink : this.definition.links[0]
    return link.endsWith('/') ? link : link + '/'
  }

  get meta(): IndexerMeta {
    const d = this.definition
    return { id: d.id, name: d.name, description: d.description, language: d.language, type: d.type, links: d.links }
  }

  get canTestLogin() {
    return this.definition.login?.test != null
  }

  updateSettings(settings: IndexerSettings) {
    this.settings = settings
  }

  // --- template variables ---------------------------------------------------------

  private baseVars(): Vars {
    const today = new Date()
    const vars: Vars = {
      '.Config.sitelink': this.siteLink,
      '.True': 'True',
      '.False': null,
      '.Today.Year': String(today.getMonth() > 0 ? today.getFullYear() : today.getFullYear() - 1),
    }
    for (const s of this.settingsFields) {
      const raw = this.settings[s.name] ?? (s.type === 'multi-select' ? s.defaults : s.default)
      const key = '.Config.' + s.name
      if (s.type === 'checkbox') vars[key] = raw === true || raw === 'true' || raw === 'True' ? 'True' : null
      else if (Array.isArray(raw)) vars[key] = raw.map(String)
      else vars[key] = raw == null ? null : String(raw)
    }
    return vars
  }

  private queryVars(query: SearchQuery, vars: Vars) {
    Object.assign(vars, {
      '.Query.Type': 'search',
      '.Query.Q': query.q,
      '.Query.Series': null,
      '.Query.Ep': null,
      '.Query.Season': null,
      '.Query.Movie': null,
      '.Query.Year': null,
      '.Query.Limit': String(query.limit ?? 100),
      '.Query.Offset': '0',
      '.Query.Extended': 'False',
      '.Query.Categories': (query.categories ?? []).map(String),
      '.Query.IMDBID': null,
      '.Query.IMDBIDShort': null,
      '.Query.Episode': '',
      '.Query.IsSearch': 'True',
    } satisfies Vars)
    const tokens = [query.q].filter((t) => !isBlank(t))
    vars['.Query.Keywords'] = tokens.join(' ')
    vars['.Keywords'] = this.filter(vars['.Query.Keywords'] as string, this.definition.search.keywordsfilters, vars)
  }

  private filter(data: string, filters: SelectorBlock['filters'], vars: Vars) {
    return applyFilters(data, filters, { vars, encoding: this.definition.encoding, log: (m) => this.log('debug', `${this.id}: ${m}`) })
  }

  private tpl(template: string | number | undefined, vars: Vars, modifier?: (s: string) => string) {
    return applyTemplate(template, vars, modifier)
  }

  private headers(custom: Record<string, string | string[]> | undefined, vars: Vars): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(custom ?? {})) out[k] = this.tpl(Array.isArray(v) ? v[0] : v, vars)
    return out
  }

  private resolve(path: string, base?: string) {
    return new URL(path, base ?? this.siteLink).href
  }

  private async fetch(req: Parameters<HttpClient['request']>[0]): Promise<HttpResponse> {
    const delay = (this.definition.requestDelay ?? 0) * 1000
    if (delay > 0) {
      const now = Date.now()
      const wait = Math.max(0, this.nextRequestAt - now)
      this.nextRequestAt = Math.max(now, this.nextRequestAt) + delay
      if (wait) await sleep(wait)
    }
    return this.http.request(req)
  }

  private text(res: HttpResponse) {
    return decode(res.body, this.definition.encoding)
  }

  // --- search ---------------------------------------------------------------------

  async search(query: SearchQuery, signal?: AbortSignal): Promise<Release[]> {
    const def = this.definition
    const search = def.search
    const vars = this.baseVars()
    this.queryVars(query, vars)

    let mapped = this.categories.toTrackerIds(query.categories ?? [])
    if (mapped.length === 0) mapped = this.categories.defaults

    const paths: SearchPathBlock[] = [...(search.paths ?? [])]
    if (search.path) paths.push({ path: search.path, inheritinputs: true })

    const releases: Release[] = []
    const seenUrls = new Set<string>()

    for (const sp of paths) {
      vars['.Categories'] = mapped
      const pathCats = (sp.categories ?? []).map(String)
      if (pathCats.length > 0) {
        let hit = mapped.some((c) => pathCats.includes(c))
        if (pathCats[0] === '!') hit = !hit
        if (!hit) continue
        vars['.Categories'] = mapped.filter((c) => pathCats.includes(c))
      }

      // Paths use UTF-8 url-encoding regardless of site charset, '+' becomes %20
      let url = this.resolve(this.tpl(sp.path, vars, (s) => urlEncode(s)).replace(/\+/g, '%20'))
      const method = sp.method?.toLowerCase() === 'post' ? 'POST' : 'GET'
      const pairs: [string, string][] = []
      const inputSets = [...(sp.inheritinputs !== false ? [search.inputs] : []), sp.inputs]
      for (const inputs of inputSets) {
        for (const [key, raw] of Object.entries(inputs ?? {})) {
          if (key === '$raw') {
            // already url-encoded by the modifier; split into pairs as-is
            for (const part of this.tpl(String(raw), vars, (s) => urlEncode(s, def.encoding)).split('&')) {
              const [k, v = ''] = part.split(/=(.*)/s)
              if (k) pairs.push([k, v])
            }
            continue
          }
          const value = this.tpl(String(raw), vars)
          if (!isBlank(value) || search.allowEmptyInputs) pairs.push([key, urlEncode(value, def.encoding)])
        }
      }
      const qs = pairs.map(([k, v]) => `${k}=${v}`).join('&')
      if (method === 'GET' && qs) url += (url.includes('?') ? '&' : '?') + qs
      if (method === 'GET' && seenUrls.has(url)) continue
      seenUrls.add(url)

      const send = async () => {
        const res = await this.fetch({ url, method, body: method === 'POST' ? qs : undefined, headers: this.headers(search.headers, vars), signal })
        const body = this.text(res)
        this.log('debug', `${this.id}: ${method} ${url} -> ${res.status} (${body.length} chars)`)
        if (isCloudflareChallenge(res, body)) throw new CloudflareError(new URL(url).origin)
        return { res, body }
      }
      if (def.login) await this.prepareSession()
      let { res, body } = await send()
      if (def.login && (res.status === 401 || this.isLoginNeeded(res, body))) {
        // Session expired or never existed: log in once with stored credentials and retry
        await this.login(signal)
        ;({ res, body } = await send())
        if (res.status === 401 || this.isLoginNeeded(res, body)) throw new LoginRequiredError('Still not logged in after signing in')
      }
      if (res.status === 401) throw new LoginRequiredError('401 Unauthorized')

      const type = sp.response?.type ?? 'html'
      if (type === 'json') releases.push(...this.parseJson(res, body, sp, vars))
      else releases.push(...this.parseHtml(res, body, type === 'xml', vars, query))
    }

    const limited = query.limit ? releases.slice(0, query.limit) : releases
    return limited.map((r) => this.fixup(r))
  }

  // --- login (port of DoLogin / TestLogin) ----------------------------------------

  private sessionPrepared = false

  /** Settings the user must fill before a programmatic login can work. */
  get loginMethod(): string | undefined {
    return this.definition.login ? (this.definition.login.method ?? 'form') : undefined
  }

  /** URL to open in a browser window so the user can sign in by hand. */
  get loginPageUrl(): string {
    const L = this.definition.login
    const path = L?.method === 'form' || L?.method === undefined ? L?.path : undefined
    return path ? this.resolve(this.tpl(path, this.baseVars())) : this.siteLink
  }

  /** Static cookies from the definition / settings, applied once per process. */
  private async prepareSession() {
    if (this.sessionPrepared) return
    this.sessionPrepared = true
    const L = this.definition.login!
    if (L.cookies?.length) await this.http.setCookies(this.siteLink, L.cookies.join('; '))
    const cookie = this.settings.cookie
    if (L.method === 'cookie' && typeof cookie === 'string' && cookie.trim()) await this.http.setCookies(this.siteLink, cookie.trim())
  }

  async login(signal?: AbortSignal): Promise<void> {
    const L = this.definition.login
    if (!L) return
    const def = this.definition
    const vars = this.baseVars()
    const headers = this.headers(L.headers ?? def.search.headers, vars)
    const enc = def.encoding
    const encodePairs = (pairs: [string, string][]) => pairs.map(([k, v]) => `${k}=${urlEncode(v, enc)}`).join('&')
    const inputs = Object.entries(L.inputs ?? {}).map(([k, v]) => [k, this.tpl(String(v), vars)] as [string, string])
    const method = L.method ?? 'form'
    if (L.cookies?.length) await this.http.setCookies(this.siteLink, L.cookies.join('; '))

    let res: HttpResponse
    if (method === 'cookie') {
      const cookie = typeof this.settings.cookie === 'string' ? this.settings.cookie.trim() : ''
      if (!cookie) throw new LoginRequiredError('Sign in through the browser (or paste a cookie)')
      await this.http.setCookies(this.siteLink, cookie)
    } else if (method === 'post') {
      this.requireCredentials()
      res = await this.fetch({ url: this.resolve(this.tpl(L.path ?? '', vars)), method: 'POST', body: encodePairs(inputs), headers, referer: this.siteLink, signal })
      this.checkLoginResponse(res)
    } else if (method === 'get') {
      const qs = encodePairs(inputs)
      res = await this.fetch({ url: this.resolve(this.tpl(L.path ?? '', vars) + (qs ? '?' + qs : '')), headers, referer: this.siteLink, signal })
      this.checkLoginResponse(res)
    } else if (method === 'oneurl') {
      const oneurl = this.tpl(String(L.inputs?.oneurl ?? ''), vars)
      res = await this.fetch({ url: this.resolve(this.tpl(L.path ?? '', vars) + oneurl), headers, referer: this.siteLink, signal })
      this.checkLoginResponse(res)
    } else if (method === 'form') {
      this.requireCredentials()
      const loginUrl = this.resolve(this.tpl(L.path ?? '', vars))
      const landing = await this.fetch({ url: loginUrl, headers, referer: this.siteLink, signal })
      if (isCloudflareChallenge(landing, this.text(landing))) throw new CloudflareError(new URL(loginUrl).origin)
      const $ = cheerio.load(this.text(landing))
      const form = $(L.form ?? 'form').first()
      if (!form.length) throw new Error(`Login failed: no form found on ${loginUrl} using selector ${L.form ?? 'form'}`)
      if (L.captcha && $(L.captcha.selector).length) throw new LoginRequiredError('This site asks for a captcha. Sign in through the browser')

      const pairs = new Map<string, string>()
      form.find('input').each((_, el) => {
        const $el = $(el)
        const name = $el.attr('name')
        if (!name || $el.is('[disabled]')) return
        const type = ($el.attr('type') ?? '').toLowerCase()
        if ((type === 'checkbox' || type === 'radio') && !$el.is('[checked]')) return
        pairs.set(name, $el.attr('value') ?? '')
      })
      for (const [key, value] of inputs) {
        const name = L.selectors ? $(key).first().attr('name') : key
        if (!name) throw new Error(`Login failed: no input found using selector ${key}`)
        pairs.set(name, value)
      }
      const root = $.root().children()[0] as Element
      for (const [key, block] of Object.entries(L.selectorinputs ?? {})) {
        const value = this.handleSelector($, block, root, vars, !block.optional)
        if (value != null) pairs.set(key, value)
      }
      const query: [string, string][] = []
      for (const [key, block] of Object.entries(L.getselectorinputs ?? {})) {
        const value = this.handleSelector($, block, root, vars, !block.optional)
        if (value != null) query.push([key, value])
      }
      let submit = L.submitpath ?? form.attr('action') ?? ''
      if (query.length) submit += '?' + encodePairs(query)
      const submitUrl = this.resolve(submit, landing.url)

      if (form.attr('enctype') === 'multipart/form-data') {
        const boundary = '---------------------------' + Date.now()
        const body = [...pairs].map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`).join('\r\n') + `\r\n--${boundary}--`
        res = await this.fetch({ url: submitUrl, method: 'POST', body, headers: { ...headers, 'Content-Type': `multipart/form-data; boundary=${boundary}` }, referer: loginUrl, signal })
      } else {
        res = await this.fetch({ url: submitUrl, method: 'POST', body: encodePairs([...pairs]), headers, referer: loginUrl, signal })
      }
      this.checkLoginResponse(res)
    } else {
      throw new Error(`Login method ${method} not implemented`)
    }

    if (!(await this.testLogin(signal))) throw new LoginRequiredError('Login failed: the site did not accept the credentials')
  }

  private requireCredentials() {
    const needs = this.settingsFields.filter((f) => f.name === 'username' || f.name === 'password' || f.name === 'apikey')
    const missing = needs.filter((f) => isBlank(this.settings[f.name] as string))
    if (missing.length) throw new LoginRequiredError(`Fill in ${missing.map((f) => f.label ?? f.name).join(', ')} or sign in through the browser`)
  }

  private checkLoginResponse(res: HttpResponse) {
    if (res.status === 401) throw new LoginRequiredError('401 Unauthorized, check your credentials')
    const body = this.text(res)
    if (isCloudflareChallenge(res, body)) throw new CloudflareError(new URL(res.url).origin)
    try {
      this.checkForError(cheerio.load(body), this.definition.login?.error)
    } catch (e) {
      throw new LoginRequiredError((e as Error).message)
    }
  }

  /** True when the session is logged in (or the definition has no way to tell). */
  async testLogin(signal?: AbortSignal): Promise<boolean> {
    const test = this.definition.login?.test
    if (!test) return true
    const headers = this.headers(this.definition.login?.headers ?? this.definition.search.headers, this.baseVars())
    const url = this.resolve(test.path)
    let res = await this.fetch({ url, headers, signal, followRedirects: false })
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, url)
      // Same-host redirects are followed once, like Jackett; anything else means "logged out"
      if (next.host !== new URL(url).host) return false
      res = await this.fetch({ url: next.href, headers, signal, followRedirects: false })
      if (res.status >= 300 && res.status < 400) return false
    }
    if (isCloudflareChallenge(res, this.text(res))) throw new CloudflareError(new URL(url).origin)
    if (!test.selector) return res.status < 400
    return cheerio.load(this.text(res))(test.selector).length > 0
  }

  private isLoginNeeded(res: HttpResponse, body: string): boolean {
    const selector = this.definition.login?.test?.selector
    if (!selector) return false
    // Only HTML pages carry the logged-in marker; skip API responses
    if (/json|xml/i.test(res.headers.get('content-type') ?? '')) return false
    return cheerio.load(body)(selector).length === 0
  }

  /** False while the site answers with a Cloudflare / DDoS-Guard challenge. */
  async checkAccess(signal?: AbortSignal): Promise<boolean> {
    const res = await this.fetch({ url: this.siteLink, signal })
    return !isCloudflareChallenge(res, this.text(res))
  }

  async logout() {
    this.sessionPrepared = false
    await this.http.clearCookies(this.siteLink)
  }

  private fixup(r: Release): Release {
    // Several JSON APIs return HTML-escaped titles ("Linux &amp; Scripting")
    if (r.title.includes('&')) r.title = decodeHTML(r.title)
    // Public definitions hardcode freeleech (no ratio there), which is just noise
    if (this.definition.type === 'public') {
      delete r.downloadVolumeFactor
      delete r.uploadVolumeFactor
    }
    if (!r.magnet && r.infoHash && this.definition.type !== 'private') r.magnet = infoHashToMagnet(r.infoHash, r.title)
    if (r.magnet && !r.infoHash) r.infoHash = magnetToInfoHash(r.magnet)
    if (r.infoHash) r.infoHash = normalizeInfoHash(r.infoHash)
    r.guid = r.link ?? r.magnet ?? r.details ?? r.title
    return r
  }

  private newRelease(): Release {
    return { indexerId: this.id, indexerName: this.name, title: '', guid: '', categories: [] }
  }

  // --- HTML / XML -----------------------------------------------------------------

  private parseHtml(res: HttpResponse, body: string, xml: boolean, vars: Vars, query: SearchQuery): Release[] {
    const search = this.definition.search
    let $ = cheerio.load(body, xml ? { xml: true } : undefined)
    if (!xml) this.checkForError($, search.error)
    if (search.preprocessingfilters) {
      $ = cheerio.load(this.filter(body, search.preprocessingfilters, vars), xml ? { xml: true } : undefined)
    }

    const rows: AnyNode[] = $(this.tpl(search.rows.selector, vars)).toArray()
    const after = search.rows.after ?? 0
    if (after > 0) {
      for (let i = 0; i < rows.length; i++) {
        for (let j = 0; j < after; j++) {
          const merge = rows[i + j + 1]
          if (merge) $(rows[i]).append($(merge).contents())
        }
        rows.splice(i + 1, after)
      }
    }

    this.log('debug', `${this.id}: ${rows.length} rows`)
    const releases: Release[] = []
    for (const row of rows) {
      try {
        const release = this.newRelease()
        this.parseFields(release, vars, res.url, (block, required) => this.handleSelector($, block, row, vars, required))
        if (this.skipByRowFilters(release, vars, query)) continue

        const dh = search.rows.dateheaders
        if (!release.publishDate && dh) {
          let value: string | null = null
          let prev = this.previousRow($, $(row))
          while (prev && prev.length) {
            try {
              value = this.handleSelector($, dh, prev[0], vars, true)
              break
            } catch {
              prev = this.previousRow($, prev)
            }
          }
          if (value == null && !dh.optional) throw new Error(`No date header row found for ${release.title}`)
          if (value != null) release.publishDate = safeDate(value)
        }
        if (release.title) releases.push(release)
      } catch (e) {
        this.log('debug', `${this.id}: error while parsing row: ${(e as Error).message}`)
      }
    }
    return releases
  }

  private previousRow($: CheerioAPI, el: Cheerio<AnyNode>): Cheerio<Element> | null {
    const prev = el.prev()
    if (prev.length) return prev
    const parentPrev = el.parent().prev()
    return parentPrev.length ? parentPrev : null
  }

  private checkForError($: CheerioAPI, blocks: ErrorBlock[] | undefined) {
    for (const err of blocks ?? []) {
      const sel = $(err.selector).first()
      if (!sel.length) continue
      let message = sel.text()
      if (err.message) message = this.handleSelector($, err.message, $.root().children()[0] as Element, this.baseVars(), false) ?? message
      throw new Error(`Error: ${message.trim()}`)
    }
  }

  private querySelector($: CheerioAPI, el: AnyNode, selector: string): Cheerio<AnyNode> {
    if (selector.startsWith(':root')) return $.root().find(selector.slice(5).trim()).first()
    return $(el).find(selector).first()
  }

  private handleSelector($: CheerioAPI, block: SelectorBlock, dom: AnyNode, vars: Vars, required: boolean): string | null {
    if (block.text != null) return this.filter(this.tpl(block.text, vars), block.filters, vars)

    let selection: Cheerio<AnyNode> = $(dom)
    if (block.selector != null) {
      const sel = this.tpl(block.selector, vars)
      selection = $(dom).is(sel) ? $(dom) : this.querySelector($, dom, sel)
      if (!selection.length) {
        if (required) throw new Error(`Selector "${sel}" didn't match`)
        return null
      }
    }

    if (block.remove) selection.find(block.remove).remove()

    let value: string | null = null
    if (block.case) {
      for (const [sel, result] of Object.entries(block.case)) {
        if (selection.is(sel) || this.querySelector($, selection[0], sel).length) {
          value = this.tpl(result, vars)
          break
        }
      }
      if (value == null) {
        if (required) throw new Error(`None of the case selectors matched`)
        return null
      }
    } else if (block.attribute) {
      value = selection.attr(block.attribute) ?? null
      if (value == null) {
        if (required) throw new Error(`Attribute "${block.attribute}" is not set`)
        return null
      }
    } else {
      value = selection.text()
    }
    return this.filter(normalizeSpace(value), block.filters, vars)
  }

  // --- JSON -----------------------------------------------------------------------

  private parseJson(res: HttpResponse, body: string, sp: SearchPathBlock, vars: Vars): Release[] {
    const rowsBlock = this.definition.search.rows
    if (res.status !== 200) throw new Error(`Error Parsing Json Response: Status=${res.status}`)
    const nrm = sp.response?.noResultsMessage
    if (nrm != null && ((nrm !== '' && body.includes(nrm)) || (nrm === '' && body === ''))) return []

    let json: unknown
    try {
      json = JSON.parse(body)
    } catch (e) {
      throw new Error('Error Parsing Json Response: ' + (e as Error).message)
    }

    if (rowsBlock.count) {
      try {
        const count = Number.parseInt(this.handleJsonSelector(rowsBlock.count, json, vars, true) ?? '', 10)
        if (!Number.isNaN(count) && count < 1) return []
      } catch {
        /* ignore */
      }
    }

    const rows = this.jsonRows(json, this.tpl(rowsBlock.selector, vars))
    if (rows == null) {
      if (rowsBlock.missingAttributeEqualsNoResults) return []
      throw new Error('Error Parsing Rows Selector. There are 0 rows.')
    }

    const releases: Release[] = []
    for (const row of rows) {
      let obj: unknown = row
      if (rowsBlock.attribute) {
        obj = selectJsonPath(row, rowsBlock.attribute)
        if (obj == null && rowsBlock.missingAttributeEqualsNoResults) continue
      }
      const items = rowsBlock.multiple ? (Array.isArray(obj) ? obj : Object.values(obj ?? {})) : [obj]
      for (const item of items) {
        try {
          const release = this.newRelease()
          this.parseFields(release, vars, res.url, (block, required) => {
            const parent = block.selector?.startsWith('..') ? row : item
            return this.handleJsonSelector(block, parent, vars, required)
          })
          if (this.skipByRowFilters(release, vars, { q: (vars['.Query.Q'] as string) ?? '' })) continue
          if (release.title) releases.push(release)
        } catch (e) {
          this.log('debug', `${this.id}: error while parsing JSON row: ${(e as Error).message}`)
        }
      }
    }
    return releases
  }

  private jsonRows(json: unknown, selector: string): unknown[] | null {
    const path = selector.split(':')[0]
    const arr = path ? selectJsonPath(json, path) : json
    if (!Array.isArray(arr)) return null
    const filters = selector.slice(path.length)
    return arr.filter((r) => this.jsonFieldSelector(r, filters) != null)
  }

  /** Resolves `path:has(x):not(y):contains(z)` against obj; returns the path or null. */
  private jsonFieldSelector(obj: unknown, selector: string): string | null {
    const path = selector.split(':')[0]
    const target = path.trim() ? selectJsonPath(obj, path) : obj
    if (target === undefined) return null
    for (const m of selector.matchAll(/:(?<filter>.+?)\((?<key>.+?)\)(?=:|$)/g)) {
      const { filter, key } = m.groups!
      const nested = /:(.+?)\((.+?)\)/.test(key)
      const exists = nested ? this.jsonFieldSelector(target, key) != null : selectJsonPath(target, key) !== undefined
      if (filter === 'has' && !exists) return null
      if (filter === 'not' && exists) return null
      if (filter === 'contains' && !JSON.stringify(target).includes(key)) return null
    }
    return path
  }

  private handleJsonSelector(block: SelectorBlock, parent: unknown, vars: Vars, required: boolean): string | null {
    if (block.text != null) return this.filter(this.tpl(block.text, vars), block.filters, vars)

    let value: string | null = null
    if (block.selector != null) {
      const sel = this.tpl(block.selector.replace(/^\.+/, ''), vars)
      const path = this.jsonFieldSelector(parent, sel)
      const selection = path == null ? undefined : path.trim() ? selectJsonPath(parent, path) : parent
      if (selection === undefined) {
        if (required) throw new Error(`Selector "${sel}" didn't match`)
        return null
      }
      value = jsonToString(selection)
    }

    if (block.case) {
      let matched: string | null = null
      for (const [key, result] of Object.entries(block.case)) {
        if ((value != null && value === key) || key === '*') {
          matched = this.tpl(result, vars)
          break
        }
      }
      if (matched == null) {
        if (required) throw new Error(`None of the case selectors matched`)
        return null
      }
      value = matched
    }
    return this.filter(normalizeSpace(value), block.filters, vars)
  }

  // --- fields ---------------------------------------------------------------------

  private parseFields(release: Release, vars: Vars, baseUrl: string, select: (block: SelectorBlock, required: boolean) => string | null) {
    for (const [key, block] of Object.entries(this.definition.search.fields)) {
      const [name, ...mods] = key.split('|')
      const varKey = '.Result.' + name
      const optional = OPTIONAL_FIELDS.includes(key) || mods.includes('optional') || block.optional === true
      let value: string | null = null
      try {
        value = select(block, !optional)
        if (optional && isBlank(value)) {
          const fallback = this.tpl(block.default, vars)
          if (isBlank(fallback)) {
            vars[varKey] = null
            continue
          }
          value = fallback
        }
        vars[varKey] = this.parseField(value ?? '', name, release, mods, baseUrl)
      } catch (e) {
        if (!(varKey in vars) || optional) vars[varKey] = null
        if (optional) continue
        throw new Error(`Error while parsing field=${key}, selector=${block.selector}, value=${value ?? '<null>'}: ${(e as Error).message}`)
      }
    }
  }

  private parseField(value: string, name: string, r: Release, mods: string[], baseUrl: string): string {
    switch (name) {
      case 'download':
        if (!value) {
          r.link = undefined
          return ''
        }
        if (value.startsWith('magnet:')) r.magnet = value
        else r.link = this.resolve(value, baseUrl)
        return r.magnet && value.startsWith('magnet:') ? value : r.link!
      case 'magnet':
        r.magnet = value
        return value
      case 'infohash':
        r.infoHash = value
        return value
      case 'details':
        r.details = this.resolve(value, baseUrl)
        return r.details
      case 'title':
        r.title = mods.includes('append') ? r.title + value : value
        return r.title
      case 'description':
        r.description = mods.includes('append') ? (r.description ?? '') + value : value
        return r.description
      case 'category':
      case 'categorydesc': {
        const cats = name === 'category' ? this.categories.fromTrackerId(value) : this.categories.fromTrackerDesc(value)
        if (cats.length) r.categories = mods.includes('noappend') ? cats : [...new Set([...r.categories, ...cats])]
        else if (value.trim()) this.log('debug', `${this.id}: invalid category for value '${value}'`)
        return value
      }
      case 'size':
        r.size = getBytes(value)
        return String(r.size)
      case 'leechers': {
        const n = coerceLong(value)
        r.leechers = n < 5_000_000 ? n : 0
        return String(r.leechers)
      }
      case 'seeders': {
        const n = coerceLong(value)
        r.seeders = n < 5_000_000 ? n : 0
        return String(r.seeders)
      }
      case 'date':
        r.publishDate = safeDate(value)
        return r.publishDate ?? value
      case 'files':
        r.files = coerceLong(value)
        return String(r.files)
      case 'grabs':
        r.grabs = coerceLong(value)
        return String(r.grabs)
      case 'downloadvolumefactor':
        r.downloadVolumeFactor = coerceDouble(value)
        return String(r.downloadVolumeFactor)
      case 'uploadvolumefactor':
        r.uploadVolumeFactor = coerceDouble(value)
        return String(r.uploadVolumeFactor)
      case 'imdb':
      case 'imdbid':
        r.imdb = getLongFromString(value) ?? undefined
        return String(r.imdb ?? '')
      case 'genre': {
        const genres = new Set([...(r.genres ?? []), ...value.split(GENRE_DELIMITERS).filter(Boolean)])
        r.genres = [...genres].map((g) => g.replace(/_/g, ' '))
        return r.genres.join(',')
      }
      case 'poster':
        if (value.trim()) r.poster = this.resolve(value, baseUrl)
        return r.poster ?? ''
      default:
        return value
    }
  }

  private skipByRowFilters(release: Release, vars: Vars, query: SearchQuery): boolean {
    for (const f of this.definition.search.rows.filters ?? []) {
      if (f.name !== 'andmatch') continue
      let keywords = (vars['.Keywords'] as string) || query.q
      const limit = f.args != null ? Number.parseInt(String(f.args), 10) : -1
      if (limit > 0) keywords = keywords.slice(0, limit)
      const parts = keywords.split(/[^\p{L}\p{N}_]+/u).filter((p) => p.trim() && p.length > 1 && !COMMON_WORDS.includes(p.toLowerCase()))
      const title = release.title.toLowerCase()
      if (!parts.every((p) => title.includes(p.toLowerCase()))) return true
    }
    return false
  }

  // --- download -------------------------------------------------------------------

  /** Turns a result into something the torrent client can add. */
  async resolveDownload(release: Pick<Release, 'link' | 'magnet' | 'title'>, signal?: AbortSignal): Promise<DownloadTarget> {
    if (!release.link && release.magnet) return { kind: 'magnet', uri: release.magnet }
    if (!release.link) throw new Error('Release has no download link')
    const def = this.definition
    if (def.login) await this.prepareSession()
    let link = release.link
    const dl = def.download

    if (dl) {
      const vars = this.baseVars()
      addUriVars(vars, new URL(link), '.DownloadUri')
      const headers = this.headers(dl.headers ?? def.search.headers, vars)
      let page: HttpResponse | null = null

      if (dl.before) {
        let path = dl.before.path
        if (dl.before.pathselector) {
          page = await this.fetch({ url: link, headers, signal })
          path = this.matchSelector(page, dl.before.pathselector, vars) ?? path
        }
        if (path) {
          const method = dl.before.method?.toLowerCase() === 'post' ? 'POST' : 'GET'
          const qs = Object.entries(dl.before.inputs ?? {})
            .map(([k, v]) => `${k}=${urlEncode(this.tpl(v, vars), def.encoding)}`)
            .join('&')
          let url = this.resolve(this.tpl(path, vars))
          if (method === 'GET' && qs) url += (url.includes('?') ? '&' : '?') + qs
          page = await this.fetch({ url, method, body: method === 'POST' ? qs : undefined, headers, referer: link, signal })
        }
      }

      if (dl.infohash) {
        if (!dl.infohash.usebeforeresponse || !page) page = await this.fetch({ url: link, headers, signal })
        const hash = this.matchSelector(page, dl.infohash.hash, vars)
        const title = this.matchSelector(page, dl.infohash.title, vars)
        if (hash && title) return { kind: 'magnet', uri: infoHashToMagnet(hash, title) }
        this.log('warn', `${this.id}: infohash selectors didn't match`)
      } else if (dl.selectors?.length) {
        let found = false
        for (const sel of dl.selectors) {
          try {
            if (!sel.usebeforeresponse || !page) page = await this.fetch({ url: link, headers, signal })
            if (page.magnet) return { kind: 'magnet', uri: page.magnet }
            const href = this.matchSelector(page, sel, vars)
            if (!href) continue
            const target = this.resolve(href, page.url)
            if (target.startsWith('magnet:')) return { kind: 'magnet', uri: target }
            if (def.testlinktorrent !== false) {
              const test = await this.fetch({ url: target, headers, referer: link, signal })
              if (test.magnet) return { kind: 'magnet', uri: test.magnet }
              if (test.body.length >= 1 && test.body[0] !== 0x64 /* 'd' */) continue
              return { kind: 'torrent', data: test.body }
            }
            link = target
            found = true
            break
          } catch (e) {
            this.log('debug', `${this.id}: download selector ${sel.selector} failed: ${(e as Error).message}`)
          }
        }
        if (!found) throw new Error("Download selectors didn't match")
      }
    }

    const res = await this.fetch({ url: link, headers: this.headers(dl?.headers ?? def.search.headers, this.baseVars()), signal })
    if (res.magnet) return { kind: 'magnet', uri: res.magnet }
    if (res.body[0] !== 0x64) {
      if (release.magnet) return { kind: 'magnet', uri: release.magnet }
      throw new Error(`Download did not return a torrent file (HTTP ${res.status})`)
    }
    return { kind: 'torrent', data: res.body }
  }

  private matchSelector(res: HttpResponse, field: SelectorField, vars: Vars): string | null {
    const $ = cheerio.load(this.text(res))
    const el = $(this.tpl(field.selector, vars)).first()
    if (!el.length) return null
    let val: string
    if (field.attribute) {
      const attr = el.attr(field.attribute)
      if (attr == null) throw new Error(`Attribute "${field.attribute}" is not set`)
      val = attr
    } else val = el.text()
    return this.filter(val, field.filters, vars)
  }
}

function safeDate(value: string): string | undefined {
  try {
    return fromUnknown(value).toISOString()
  } catch {
    return undefined
  }
}

function jsonToString(v: unknown): string | null {
  if (v == null) return null
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : jsonScalar(x))).join(',')
  if (typeof v === 'object') return JSON.stringify(v)
  return jsonScalar(v)
}

// Json.NET renders booleans as True/False, and definitions match on that
const jsonScalar = (x: unknown) => (typeof x === 'boolean' ? (x ? 'True' : 'False') : String(x))

function addUriVars(vars: Vars, uri: URL, prefix: string) {
  vars[prefix + '.AbsoluteUri'] = uri.href
  vars[prefix + '.AbsolutePath'] = uri.pathname
  vars[prefix + '.Scheme'] = uri.protocol.replace(':', '')
  vars[prefix + '.Host'] = uri.hostname
  vars[prefix + '.Port'] = uri.port || (uri.protocol === 'https:' ? '443' : '80')
  vars[prefix + '.PathAndQuery'] = uri.pathname + uri.search
  vars[prefix + '.Query'] = uri.search
  for (const [k, v] of uri.searchParams) if (!((prefix + '.Query.' + k) in vars)) vars[prefix + '.Query.' + k] = v
}
