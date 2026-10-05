// Opens a protected tracker's check window and records the requests the app itself sends to that
// site in the background (not the window's own page loads) while the window is open.
// A protected site must not be polled while its check page is showing: background
// requests reset the check's cookies and the user gets the checkbox again and again.
//   npm run build && node scripts/e2e-site-window.mjs [trackerId] [seconds]

import { _electron as electron } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const id = process.argv[2] ?? '1337x'
const seconds = Number(process.argv[3] ?? 20)

const app = await electron.launch({
  executablePath: join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
  args: [root],
  env: { ...process.env, TORSEEK_USER_DATA: mkdtempSync(join(tmpdir(), 'torseek-e2e-')), TORSEEK_NO_UPDATE: '1', TORSEEK_LANG: 'en' },
})
const page = await app.firstWindow()
await page.waitForSelector('nav button')

// Requests without a webContents come from the main process (net.request), i.e. our engine
await app.evaluate(({ session }) => {
  globalThis.__bg = []
  session.fromPartition('persist:trackers').webRequest.onCompleted((d) => {
    if (!d.webContentsId) globalThis.__bg.push(`${d.statusCode} ${d.url}`)
  })
})

const winPromise = app.waitForEvent('window')
const result = page.evaluate((x) => window.api.passChallenge(x).then((r) => r.ok), id)
const site = await winPromise
const closed = site.waitForEvent('close').then(() => 'closed by the app (check passed)')
await Promise.race([site.waitForTimeout(seconds * 1000).catch(() => {}), closed])
const title = await site.title().catch(() => '(closed)')
const body = await site.evaluate(() => document.body?.innerText.slice(0, 120)).catch(() => '')
const bg = await app.evaluate(() => globalThis.__bg)
console.log(`window after ${seconds}s: "${title}" — ${String(body).replace(/\s+/g, ' ')}`)
console.log(`background requests to the site while the window was open: ${bg.length}`)
for (const r of bg.slice(0, 10)) console.log('  ' + r.slice(0, 120))
await site.close().catch(() => {})
console.log('passChallenge ok:', await result.catch((e) => e.message))
await app.close()
