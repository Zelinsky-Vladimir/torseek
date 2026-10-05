import { app, net, session, type Session } from 'electron'
import type { CookieStore, FetchLike } from '../core/http'

// Tracker traffic goes through Chromium's network stack, in one persistent session that
// is shared with the sign-in / challenge windows. That gives:
//  - one cookie store: log in by hand in a window, the engine is logged in too
//  - a real browser TLS/HTTP2 fingerprint, so Cloudflare clearance cookies stay valid
// `session.fetch` can't do manual redirects (we need them to catch magnet: redirects),
// so this wraps the lower-level net.request.

export const TRACKER_PARTITION = 'persist:trackers'

export function trackerSession(): Session {
  return session.fromPartition(TRACKER_PARTITION)
}

/** Chrome UA without the "Electron/x" and app tokens, which sites like to block. */
export function browserUserAgent(): string {
  return app.userAgentFallback.replace(/\s(Electron|torseek)\/\S+/gi, '')
}

export function electronFetch(ses: Session): FetchLike {
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const req = net.request({
        url,
        method: init.method ?? 'GET',
        session: ses,
        useSessionCookies: true,
        redirect: 'manual',
      })
      for (const [k, v] of Object.entries((init.headers as Record<string, string>) ?? {})) {
        // Cookies come from the session; a manual header would replace them
        if (k.toLowerCase() !== 'cookie') req.setHeader(k, v)
      }

      const signal = init.signal
      const onAbort = () => {
        req.abort()
        reject(signal?.reason ?? new Error('aborted'))
      }
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      const done = () => signal?.removeEventListener('abort', onAbort)

      req.on('redirect', (status, _method, redirectUrl, headers) => {
        const h = new Headers()
        for (const [k, v] of Object.entries(headers)) for (const item of [v].flat()) h.append(k, String(item))
        h.set('location', redirectUrl)
        done()
        resolve(new Response(null, { status, headers: h }))
        req.abort()
      })
      req.on('response', (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          done()
          const h = new Headers()
          for (const [k, v] of Object.entries(res.headers)) for (const item of [v].flat()) h.append(k, String(item))
          const status = res.statusCode
          const nullBody = status === 204 || status === 304 || (status >= 300 && status < 400)
          resolve(new Response(nullBody ? null : Buffer.concat(chunks), { status: status < 200 || status > 599 ? 502 : status, headers: h }))
        })
        res.on('error', (e: Error) => {
          done()
          reject(e)
        })
      })
      req.on('error', (e) => {
        done()
        reject(e)
      })
      if (init.body != null) req.write(init.body as string)
      req.end()
    })
}

export function sessionCookieStore(ses: Session): CookieStore {
  return {
    async set(url, cookie) {
      const { protocol, hostname } = new URL(url)
      for (const part of cookie.split(';')) {
        const eq = part.indexOf('=')
        if (eq < 1) continue
        await ses.cookies.set({
          url: `${protocol}//${hostname}/`,
          name: part.slice(0, eq).trim(),
          value: part.slice(eq + 1).trim(),
          domain: '.' + hostname.replace(/^www\./, ''),
          path: '/',
          secure: protocol === 'https:',
          expirationDate: Date.now() / 1000 + 365 * 86400,
        })
      }
    },
    async clear(url) {
      const host = new URL(url).hostname.replace(/^www\./, '')
      for (const c of await ses.cookies.get({})) {
        const domain = (c.domain ?? '').replace(/^\./, '')
        if (domain === host || domain.endsWith('.' + host) || host.endsWith('.' + domain)) {
          await ses.cookies.remove(`http${c.secure ? 's' : ''}://${domain}${c.path ?? '/'}`, c.name)
        }
      }
    },
    async has(url, name) {
      return (await ses.cookies.get({ url })).some((c) => c.name === name)
    },
  }
}
