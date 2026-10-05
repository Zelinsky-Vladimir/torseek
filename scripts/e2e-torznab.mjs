// Enables the Torznab API in the built app and queries it the way Sonarr would.
//   npm run build && node scripts/e2e-torznab.mjs

import { _electron as electron } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!ok) process.exitCode = 1
}

const app = await electron.launch({
  executablePath: join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
  args: [root],
  env: { ...process.env, TORSEEK_USER_DATA: mkdtempSync(join(tmpdir(), 'torseek-e2e-')), TORSEEK_NO_UPDATE: '1', TORSEEK_DOWNLOAD_DIR: mkdtempSync(join(tmpdir(), 'torseek-dl-')), TORSEEK_LANG: 'en' },
})
const page = await app.firstWindow()
await page.waitForSelector('nav button')
const settings = await page.evaluate(() => window.api.updateSettings({ torznabEnabled: true, torznabPort: 9119 }))
const status = await page.evaluate(() => window.api.torznabStatus())
check(status.running && status.port === 9119, `server running on ${status.port}`)

const base = `http://127.0.0.1:9119/api/v2.0/indexers/all/results/torznab/api`
const key = settings.torznabApiKey
check((await fetch(`${base}?t=caps&apikey=wrong`)).status === 401, 'wrong key rejected')
const caps = await (await fetch(`${base}?t=caps&apikey=${key}`)).text()
check(caps.includes('<tv-search available="yes"'), 'caps served')

const t0 = Date.now()
const rss = await (await fetch(`${base}?t=tvsearch&q=the%20boys&season=5&ep=3&cat=5000,5040&apikey=${key}`)).text()
const items = [...rss.matchAll(/<item>[\s\S]*?<\/item>/g)].map((m) => m[0])
const titles = items.map((i) => /<title>([^<]+)/.exec(i)?.[1])
check(items.length > 0, `tvsearch returned ${items.length} items in ${Date.now() - t0}ms, e.g. ${titles.slice(0, 3).join(' | ')}`)
check(titles.every((t) => /s0?5e0?3/i.test(t ?? '')) || titles.filter((t) => /s0?5e0?3/i.test(t ?? '')).length > items.length / 2, 'items are mostly S05E03')

const link = /<link>([^<]+)<\/link>/.exec(items[0])?.[1].replace(/&amp;/g, '&')
const dl = await fetch(link, { redirect: 'manual' })
const location = dl.headers.get('location')
check(
  (dl.status === 302 && location?.startsWith('magnet:')) || dl.headers.get('content-type') === 'application/x-bittorrent',
  `/dl resolves (${dl.status} ${location ? location.slice(0, 50) + '…' : dl.headers.get('content-type')})`,
)
await app.close()
