// Drives the built app: enables every public tracker, searches, and prints per-tracker
// status as the UI shows it. Optionally opens one tracker's site window.
//   npm run build && node scripts/e2e-trackers.mjs [query] [--open <trackerId>] [--signin <trackerId>]

import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shots = process.env.SHOT_DIR ?? join(root, 'screenshots')
mkdirSync(shots, { recursive: true })
const args = process.argv.slice(2)
const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined)
const query = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? 'dune'

const app = await electron.launch({
  executablePath: join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
  args: [root],
  env: { ...process.env, TORSEEK_USER_DATA: mkdtempSync(join(tmpdir(), 'torseek-e2e-')), TORSEEK_NO_UPDATE: '1', TORSEEK_LANG: 'en' },
})
app.process().stderr?.on('data', (d) => /error/i.test(String(d)) && process.stdout.write(`[main:err] ${d}`))
const page = await app.firstWindow()
await page.waitForSelector('input[placeholder^="Search"]')
await page.waitForFunction(() => !document.querySelector('input[placeholder^="Search"]').placeholder.startsWith('Search 0 '))

// enable all public trackers through the real API
const enabled = await page.evaluate(async () => {
  const list = await window.api.listIndexers()
  const pub = list.filter((i) => i.type === 'public' && !i.unsupported)
  for (const i of pub) await window.api.setIndexerEnabled(i.id, true)
  return pub.length
})
await page.reload()
await page.waitForSelector('input[placeholder^="Search"]')
console.log(`enabled ${enabled} public trackers`)

const t0 = Date.now()
await page.fill('input[placeholder^="Search"]', query)
await page.keyboard.press('Enter')
await page.waitForSelector('text=Results from', { timeout: 90_000 })
console.log(`search finished in ${Date.now() - t0}ms`)
await page.click('text=Results from')
const chips = await page.$$eval('div.flex-wrap.gap-1\\.5 > button', (els) => els.map((e) => e.textContent.trim()))
const tally = {}
for (const c of chips) {
  const tail = c.match(/(\d+|unlock|sign in|error|timeout)$/)?.[1] ?? '?'
  const key = /^\d+$/.test(tail) ? (tail === '0' ? 'zero' : 'results') : tail
  tally[key] = (tally[key] ?? 0) + 1
}
console.log('tally', tally)
console.log('blocked:', chips.filter((c) => c.endsWith('unlock')).join(', '))
console.log('errors:', chips.filter((c) => c.endsWith('error')).join(', '))
await page.screenshot({ path: join(shots, 'trackers-search.png') })

const openId = flag('--open')
if (openId) {
  const winPromise = app.waitForEvent('window')
  void page.evaluate((id) => window.api.passChallenge(id), openId).then((r) => console.log('passChallenge result:', r.ok, r.message ?? ''))
  const site = await winPromise
  await site.waitForLoadState('domcontentloaded').catch(() => {})
  await site.waitForTimeout(12_000)
  if (!site.isClosed()) {
    await site.screenshot({ path: join(shots, `site-${openId}.png`) })
    console.log('site window still open (title):', await site.title())
    await site.close()
  } else console.log('site window closed by itself (check passed)')
  await page.waitForTimeout(3000)
}

const signId = flag('--signin')
if (signId) {
  const winPromise = app.waitForEvent('window')
  void page.evaluate((id) => window.api.signInWithBrowser(id), signId).then((r) => console.log('signIn result:', r.ok, r.message ?? ''))
  const site = await winPromise
  await site.waitForLoadState('domcontentloaded').catch(() => {})
  await site.waitForTimeout(5000)
  await site.screenshot({ path: join(shots, `signin-${signId}.png`) })
  console.log('sign-in window url:', site.url())
  await site.close()
  await page.waitForTimeout(5000)
}

await app.close()
