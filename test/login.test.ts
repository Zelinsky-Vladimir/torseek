import { describe, expect, it } from 'vitest'
import { CardigannIndexer } from '../src/core/cardigann/indexer'
import { parseDefinition } from '../src/core/cardigann/loader'
import { HttpClient } from '../src/core/http'
import { LoginRequiredError } from '../src/core/indexer'

// A tiny fake tracker: a login form, a session cookie, and a search page that only
// shows results (and a logout link) when the cookie is present.
function fakeSite() {
  const log: { method: string; url: string; body?: string; cookie?: string }[] = []
  let validSession = 'sess-ok'
  const page = (inner: string, loggedIn: boolean) =>
    `<html><body>${loggedIn ? '<a href="logout.php">logout</a>' : '<a href="login.php">login</a>'}${inner}</body></html>`

  const fetch = async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>
    const cookie = headers.Cookie
    log.push({ method: init.method ?? 'GET', url, body: init.body as string | undefined, cookie })
    const loggedIn = cookie?.includes(`sid=${validSession}`) ?? false
    const u = new URL(url)
    if (u.pathname === '/login.php' && init.method !== 'POST') {
      return new Response(page('<form action="takelogin.php"><input name="csrf" value="tok123"><input name="remember" type="checkbox"><input name="user"><input name="pass"></form>', false))
    }
    if (u.pathname === '/takelogin.php') {
      const form = new URLSearchParams(init.body as string)
      if (form.get('user') === 'alice' && form.get('pass') === 'secret' && form.get('csrf') === 'tok123') {
        return new Response(null, { status: 302, headers: { location: '/index.php', 'set-cookie': `sid=${validSession}; path=/` } })
      }
      return new Response(page('<div class="error">Wrong password</div>', false))
    }
    if (u.pathname === '/index.php') return new Response(page('<h1>home</h1>', loggedIn))
    if (u.pathname === '/browse.php') {
      const rows = loggedIn ? '<table><tr class="t"><td><a class="n" href="/t/1">Secret Release 1080p</a></td><td class="s">10</td></tr></table>' : ''
      return new Response(page(rows, loggedIn))
    }
    return new Response('not found', { status: 404 })
  }
  return { fetch, log, expire: () => (validSession = 'sess-new') }
}

const definition = (method: 'form' | 'post') =>
  parseDefinition(`
id: fake
name: Fake
type: private
links: [https://fake.test/]
caps:
  categorymappings:
    - {id: 1, cat: Movies}
settings:
  - {name: username, type: text, label: Username}
  - {name: password, type: password, label: Password}
login:
  path: ${method === 'form' ? 'login.php' : 'takelogin.php'}
  method: ${method}
  inputs:
    user: "{{ .Config.username }}"
    pass: "{{ .Config.password }}"
${method === 'post' ? '    csrf: tok123' : ''}
  error:
    - selector: div.error
  test:
    path: index.php
    selector: a[href="logout.php"]
search:
  paths:
    - path: browse.php
  inputs:
    q: "{{ .Keywords }}"
  rows:
    selector: tr.t
  fields:
    title:
      selector: a.n
    details:
      selector: a.n
      attribute: href
    download:
      selector: a.n
      attribute: href
    seeders:
      selector: td.s
    size:
      text: 1 GB
`)

describe('Cardigann login', () => {
  for (const method of ['form', 'post'] as const) {
    it(`${method}: logs in on first search, then reuses the session`, async () => {
      const site = fakeSite()
      const http = new HttpClient({ fetch: site.fetch, cookieJar: true })
      const ix = new CardigannIndexer(definition(method), { http, settings: { username: 'alice', password: 'secret' } })

      const results = await ix.search({ q: 'secret' })
      expect(results.map((r) => r.title)).toEqual(['Secret Release 1080p'])
      if (method === 'form') {
        const post = site.log.find((l) => l.url.endsWith('/takelogin.php'))!
        // hidden csrf from the form is carried over, unchecked checkbox is dropped
        expect(new URLSearchParams(post.body).get('csrf')).toBe('tok123')
        expect(new URLSearchParams(post.body).has('remember')).toBe(false)
      }

      const before = site.log.length
      await ix.search({ q: 'secret' })
      expect(site.log.slice(before).some((l) => l.url.includes('login'))).toBe(false)
      expect(await ix.testLogin()).toBe(true)
    })
  }

  it('re-logs in when the session expires', async () => {
    const site = fakeSite()
    const http = new HttpClient({ fetch: site.fetch, cookieJar: true })
    const ix = new CardigannIndexer(definition('post'), { http, settings: { username: 'alice', password: 'secret' } })
    await ix.search({ q: 'x' })
    site.expire()
    const results = await ix.search({ q: 'x' })
    expect(results).toHaveLength(1)
  })

  it('reports bad credentials and missing credentials as LoginRequiredError', async () => {
    const site = fakeSite()
    const http = new HttpClient({ fetch: site.fetch, cookieJar: true })
    const wrong = new CardigannIndexer(definition('form'), { http, settings: { username: 'alice', password: 'nope' } })
    await expect(wrong.search({ q: 'x' })).rejects.toThrow(/Wrong password/)
    const empty = new CardigannIndexer(definition('form'), { http: new HttpClient({ fetch: site.fetch, cookieJar: true }) })
    await expect(empty.search({ q: 'x' })).rejects.toBeInstanceOf(LoginRequiredError)
  })

  it('logout clears the session', async () => {
    const site = fakeSite()
    const http = new HttpClient({ fetch: site.fetch, cookieJar: true })
    const ix = new CardigannIndexer(definition('post'), { http, settings: { username: 'alice', password: 'secret' } })
    await ix.login()
    expect(await ix.testLogin()).toBe(true)
    await ix.logout()
    expect(await ix.testLogin()).toBe(false)
  })
})
