import { BrowserWindow } from 'electron'
import { trackerSession, browserUserAgent } from './net'

// A plain browser window onto a tracker site, in the shared tracker session. The user
// passes a "checking your browser" page themselves; we only watch for the moment it
// worked and then close the window. No preload, no Node, sandboxed.
//
// isDone() makes its own request to the site, and doing that while the check is still
// running restarts it (the user ticks the box, it spins, the box comes back). So we only
// call it once the page in the window no longer shows a challenge.

// Cloudflare sets window._cf_chl_opt on its interstitial; the rest covers Turnstile and DDoS-Guard
const CHALLENGE_PROBE = `(() => {
  if (document.readyState !== 'complete') return true
  if (window._cf_chl_opt) return true
  if (document.querySelector('#challenge-form, #challenge-running, #challenge-stage, .cf-turnstile, iframe[src*="challenges.cloudflare.com"], #ddg-captcha, #ddg-l10n-title')) return true
  return /just a moment|один момент|attention required|checking your browser|verifying you are human|ddos-guard/i.test(document.title)
})()`


export interface SiteWindowOptions {
  parent?: BrowserWindow | null
  url: string
  title: string
  /** Polled after navigations and on an interval; true closes the window. Omit to let the user close it. */
  isDone?: () => Promise<boolean>
  pollMs?: number
}

export function openSiteWindow(opts: SiteWindowOptions): Promise<'done' | 'closed'> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      parent: opts.parent ?? undefined,
      width: 1100,
      height: 780,
      title: opts.title,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        session: trackerSession(),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    })
    // Keep our title (with instructions) instead of the page's
    win.on('page-title-updated', (e) => e.preventDefault())
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void win.loadURL(url)
      return { action: 'deny' }
    })

    let finished = false
    let checking = false
    const finish = (result: 'done' | 'closed') => {
      if (finished) return
      finished = true
      clearInterval(timer)
      if (!win.isDestroyed()) win.close()
      resolve(result)
    }
    const challengeShown = () => win.webContents.executeJavaScript(CHALLENGE_PROBE, true).then(Boolean, () => true)
    const check = async () => {
      if (!opts.isDone || checking || finished || win.isDestroyed() || win.webContents.isLoading()) return
      checking = true
      try {
        if (!(await challengeShown()) && !finished && (await opts.isDone())) finish('done')
      } catch {
        /* not yet */
      } finally {
        checking = false
      }
    }
    const timer = setInterval(() => void check(), opts.pollMs ?? 3000)
    win.webContents.on('did-finish-load', () => void setTimeout(() => void check(), 800))
    win.on('closed', () => finish('closed'))

    void win.loadURL(opts.url, { userAgent: browserUserAgent() })
  })
}
