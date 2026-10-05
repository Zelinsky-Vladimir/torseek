// Multi-language search and themes in the built app.
//   npm run build && node scripts/e2e-appearance.mjs [query]
// Runs the query with "search in other languages" off and on and compares the
// results, then screenshots the app in every theme.

import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shots = process.env.SHOT_DIR ?? join(root, 'screenshots')
mkdirSync(shots, { recursive: true })
const query = process.argv[2] ?? 'дюна'

const app = await electron.launch({
  executablePath: join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
  args: [root],
  env: { ...process.env, TORSEEK_USER_DATA: mkdtempSync(join(tmpdir(), 'torseek-e2e-')), TORSEEK_NO_UPDATE: '1', TORSEEK_LANG: process.env.TORSEEK_LANG ?? 'ru' },
})
const page = await app.firstWindow()
page.on('pageerror', (e) => console.log('[renderer:exception]', e.message))
await page.waitForSelector('nav button')
await page.waitForTimeout(1500)

// Raw search through the API: every result and the per-tracker counts
const run = (q) =>
  page.evaluate(
    (q) =>
      new Promise((resolve) => {
        const searchId = `e2e-${Math.random()}`
        const out = { titles: [], variants: [], counts: {} }
        const off = window.api.onSearchEvent((e) => {
          if (e.searchId !== searchId) return
          if (e.type === 'results') out.titles.push(...e.releases.map((r) => r.title))
          if (e.type === 'variants') out.variants = e.names
          if (e.type === 'status' && e.status.state === 'done') out.counts[e.status.indexerName] = e.status.count
          if (e.type === 'done') off() || resolve(out)
        })
        void window.api.search({ searchId, q })
      }),
    q,
  )

await page.evaluate(() => window.api.updateSettings({ searchOtherLanguages: false }))
const plain = await run(query)
await page.evaluate(() => window.api.updateSettings({ searchOtherLanguages: true }))
const smart = await run(query)
console.log(`"${query}" only: ${plain.titles.length} results from ${Object.values(plain.counts).filter(Boolean).length} trackers`)
console.log(`"${query}" + ${JSON.stringify(smart.variants)}: ${smart.titles.length} results from ${Object.values(smart.counts).filter(Boolean).length} trackers`)
const gained = Object.entries(smart.counts).filter(([n, c]) => c > (plain.counts[n] ?? 0)).map(([n, c]) => `${n} ${plain.counts[n] ?? 0}->${c}`)
console.log('trackers that found more:', gained.join(', '))
console.log('sample new titles:', smart.titles.filter((t) => !plain.titles.includes(t)).slice(0, 5))

// The UI search, to see the "also searched" line
await page.locator('input').first().fill(query)
await page.keyboard.press('Enter')
await page.waitForTimeout(10_000)
await page.screenshot({ path: join(shots, 'lang-search.png') })

// Every theme card on the settings page, each with another accent
const nav = page.locator('nav button')
await nav.last().click()
await page.waitForTimeout(500)
const cards = page.locator('button[aria-pressed]')
const accents = page.locator('button[aria-label][title]').filter({ hasNot: page.locator('*') })
const n = await cards.count()
for (let i = 1; i < n; i++) {
  await cards.nth(i).click()
  await accents.nth((i - 1) % 7).click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(shots, `theme-${i}.png`) })
  if (i === 2 || i === 6) {
    await nav.first().click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(shots, `theme-${i}-search.png`) })
    await nav.last().click()
    await page.waitForTimeout(300)
  }
}
console.log(`${n} theme cards, screenshots in ${shots}`)
await app.close()
