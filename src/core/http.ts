// HTTP layer used by indexers. The fetch implementation is injectable: in Electron we
// pass the Chromium-backed `session.fetch` (real browser TLS + cookie store), in tests
// and the CLI we use Node's global fetch with a small cookie jar.

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface HttpRequest {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  /** Already-encoded application/x-www-form-urlencoded body */
  body?: string
  referer?: string
  signal?: AbortSignal
  /** Follow redirects (default true). Redirects to magnet: are never followed. */
  followRedirects?: boolean
}

export interface HttpResponse {
  status: number
  url: string
  headers: Headers
  body: Uint8Array
  /** Set when a redirect pointed at a magnet: URI */
  magnet?: string
}

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/** External cookie storage, e.g. an Electron session shared with login windows. */
export interface CookieStore {
  /** `cookie` is a header-style string: "a=1; b=2" */
  set(url: string, cookie: string): Promise<void>
  clear(url: string): Promise<void>
  has(url: string, name: string): Promise<boolean>
}

export interface HttpClientOptions {
  fetch?: FetchLike
  userAgent?: string
  /** Keep our own cookie jar (not needed when the fetch impl has one, e.g. Electron session) */
  cookieJar?: boolean
  /** Where setCookies/clearCookies go when the fetch impl manages cookies itself */
  cookieStore?: CookieStore
  timeoutMs?: number
}

export class HttpClient {
  private readonly fetchImpl: FetchLike
  private readonly userAgent: string
  private readonly timeoutMs: number
  private readonly jar?: Map<string, Map<string, string>>
  private readonly cookieStore?: CookieStore

  constructor(opts: HttpClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init))
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT
    this.timeoutMs = opts.timeoutMs ?? 20_000
    this.cookieStore = opts.cookieStore
    if (opts.cookieJar) this.jar = new Map()
  }

  /** Add cookies ("a=1; b=2") for the host of `url`. */
  async setCookies(url: string, cookie: string) {
    if (this.cookieStore) return this.cookieStore.set(url, cookie)
    if (!this.jar) return
    const host = new URL(url).hostname
    if (!this.jar.has(host)) this.jar.set(host, new Map())
    for (const part of cookie.split(';')) {
      const eq = part.indexOf('=')
      if (eq > 0) this.jar.get(host)!.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
    }
  }

  async clearCookies(url: string) {
    if (this.cookieStore) return this.cookieStore.clear(url)
    const host = new URL(url).hostname
    for (const domain of this.jar?.keys() ?? []) if (host === domain || host.endsWith('.' + domain) || domain.endsWith('.' + host)) this.jar!.delete(domain)
  }

  async hasCookie(url: string, name: string): Promise<boolean> {
    if (this.cookieStore) return this.cookieStore.has(url, name)
    return (this.cookiesFor(url) ?? '').split('; ').some((c) => c.startsWith(name + '='))
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs)
    let url = req.url
    let method = req.method ?? 'GET'
    let body = req.body

    for (let hop = 0; hop < 6; hop++) {
      const headers: Record<string, string> = {
        'User-Agent': this.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        ...req.headers,
      }
      if (req.referer) headers.Referer = req.referer
      if (body !== undefined) headers['Content-Type'] ??= 'application/x-www-form-urlencoded'
      const cookie = this.cookiesFor(url)
      if (cookie) headers.Cookie = cookie

      const res = await this.fetchImpl(url, { method, headers, body, redirect: 'manual', signal })
      this.storeCookies(url, res.headers)

      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && location) {
        if (location.startsWith('magnet:')) {
          return { status: res.status, url, headers: res.headers, body: new Uint8Array(), magnet: location }
        }
        if (req.followRedirects === false) {
          return { status: res.status, url, headers: res.headers, body: new Uint8Array(await res.arrayBuffer()) }
        }
        url = new URL(location, url).href
        if (res.status !== 307 && res.status !== 308) {
          method = 'GET'
          body = undefined
        }
        continue
      }
      return { status: res.status, url, headers: res.headers, body: new Uint8Array(await res.arrayBuffer()) }
    }
    throw new Error(`Too many redirects for ${req.url}`)
  }

  private cookiesFor(url: string): string | undefined {
    if (!this.jar) return undefined
    const host = new URL(url).hostname
    const parts: string[] = []
    for (const [domain, cookies] of this.jar) {
      if (host === domain || host.endsWith('.' + domain)) for (const [k, v] of cookies) parts.push(`${k}=${v}`)
    }
    return parts.length ? parts.join('; ') : undefined
  }

  private storeCookies(url: string, headers: Headers) {
    if (!this.jar) return
    const host = new URL(url).hostname
    for (const line of headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = line.split(';')
      const eq = pair.indexOf('=')
      if (eq < 1) continue
      const domainAttr = attrs.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith('domain='))
      const domain = domainAttr ? domainAttr.slice(7).replace(/^\./, '') : host
      if (!this.jar.has(domain)) this.jar.set(domain, new Map())
      this.jar.get(domain)!.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }
}

/** Cloudflare / DDoS-Guard interstitial instead of the real page. */
export function isCloudflareChallenge(res: HttpResponse, body: string): boolean {
  if (![403, 429, 503].includes(res.status)) return false
  const server = res.headers.get('server')?.toLowerCase() ?? ''
  return (
    server.includes('cloudflare') ||
    server.includes('ddos-guard') ||
    /challenge-platform|cf-chl-|Just a moment\.\.\.|ddos-guard/i.test(body.slice(0, 20_000))
  )
}
